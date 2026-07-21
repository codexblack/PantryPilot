from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.config import get_settings
from app.schemas import (
    PlanRequest,
    PlanResponse,
    RecipeImageRequest,
    RecipeImageResponse,
    ScanResponse,
    StoreLookupRequest,
    StoreLookupResponse,
)
from app.services.grocery import lookup_store_offers
from app.services.planning import create_plan, drain_pending_plans
from app.services.recipe_images import GeneratedRecipeImageProvider
from app.services.video import (
    extract_keyframes_async,
    has_expected_media_type,
    persist_upload,
    prepare_image_uploads,
)
from app.services.vision import demo_inventory, recognize_frames

logger = logging.getLogger(__name__)


async def _wait_for_disconnect(request: Request) -> None:
    """Wait until the ASGI server reports that the client disconnected."""
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


async def _run_while_connected[ResultT](
    request: Request,
    operation: Awaitable[ResultT],
) -> ResultT:
    """Cancel a provider operation when its HTTP client disconnects."""
    operation_task = asyncio.ensure_future(operation)
    disconnect_task = asyncio.create_task(_wait_for_disconnect(request))
    try:
        done, _ = await asyncio.wait(
            {operation_task, disconnect_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if operation_task in done:
            return await operation_task
        operation_task.cancel()
        await asyncio.gather(operation_task, return_exceptions=True)
        raise HTTPException(status_code=499, detail="Client closed the request.")
    finally:
        disconnect_task.cancel()
        await asyncio.gather(disconnect_task, return_exceptions=True)


def _openai_failure(error: Exception, operation: str) -> HTTPException:
    """Translate OpenAI failures into stable public API errors."""
    if isinstance(error, APITimeoutError):
        return HTTPException(
            status_code=504,
            detail=(
                f"OpenAI did not return the {operation} result in time. Retry with fewer inputs."
            ),
        )
    if isinstance(error, APIConnectionError):
        return HTTPException(
            status_code=503,
            detail=f"The server could not reach OpenAI for {operation}. Retry shortly.",
        )
    if isinstance(error, APIStatusError):
        status_code = 503 if error.status_code == 429 else 502
        return HTTPException(
            status_code=status_code,
            detail=f"OpenAI could not complete {operation}. Retry shortly.",
        )
    return HTTPException(
        status_code=502,
        detail=f"{operation.capitalize()} failed on the server. Retry shortly.",
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialize and close process-scoped service clients."""
    settings = get_settings()
    openai_client = None
    if settings.openai_api_key:
        openai_client = AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.openai_timeout_seconds,
            max_retries=0,
        )
    app.state.openai_client = openai_client
    try:
        yield
    finally:
        await drain_pending_plans()
        await GeneratedRecipeImageProvider.drain_pending_tasks()
        if openai_client is not None:
            await openai_client.close()


settings = get_settings()
app = FastAPI(
    title="PantryPilot API",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1_000)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/scan", response_model=ScanResponse)
async def scan_pantry(
    request: Request,
    videos: list[UploadFile] | None = File(default=None, alias="video"),
    images: list[UploadFile] | None = File(default=None),
) -> ScanResponse:
    settings = get_settings()
    video_set = videos or []
    photo_set = images or []
    logger.info(
        "Pantry scan received: videos=%d photos=%d api_configured=%s",
        len(video_set),
        len(photo_set),
        bool(settings.openai_api_key),
    )
    if len(video_set) > 1:
        raise HTTPException(status_code=422, detail="Choose no more than one video.")
    if bool(video_set) == bool(photo_set):
        raise HTTPException(
            status_code=422,
            detail=(f"Choose exactly one video or between 1 and {settings.max_images} photos."),
        )

    video = video_set[0] if video_set else None
    openai_client = getattr(request.app.state, "openai_client", None)

    if video is None:
        frames = await prepare_image_uploads(
            photo_set,
            settings.max_images,
            settings.max_upload_mb * 1024 * 1024,
            settings.max_image_upload_mb * 1024 * 1024,
        )
        logger.info("Prepared %d photo frame(s) for recognition", len(frames))
        if not settings.openai_api_key:
            return ScanResponse(
                ingredients=demo_inventory(),
                frames_analyzed=len(frames),
                demo_mode=True,
                notice=(
                    "Demo inventory shown. Add OPENAI_API_KEY on the API server "
                    "to analyze your own photos."
                ),
            )
        try:
            ingredients = await _run_while_connected(
                request,
                recognize_frames(
                    frames,
                    settings.openai_api_key,
                    settings.openai_model,
                    settings.openai_timeout_seconds,
                    openai_client,
                    image_detail="low",
                ),
            )
            logger.info("Pantry photo scan completed: ingredients=%d", len(ingredients))
            return ScanResponse(
                ingredients=ingredients, frames_analyzed=len(frames), demo_mode=False
            )
        except ValueError as error:
            raise HTTPException(
                status_code=502,
                detail=(
                    "Recognition returned an unreadable result. Please retry with clearer photos."
                ),
            ) from error
        except (APITimeoutError, APIConnectionError, APIStatusError) as error:
            logger.exception("Photo recognition provider failure")
            raise _openai_failure(error, "photo recognition") from error
        except HTTPException:
            raise
        except Exception as error:
            logger.exception("Photo recognition failed")
            raise HTTPException(
                status_code=502,
                detail=(
                    "Photo analysis failed on the server. Check OPENAI_API_KEY "
                    "and the server log, then retry."
                ),
            ) from error

    if not has_expected_media_type(video, "video/"):
        raise HTTPException(status_code=415, detail="Please upload a video file.")
    path = await persist_upload(video, settings.max_upload_mb * 1024 * 1024)
    try:
        frames = await extract_keyframes_async(
            path,
            settings.max_frames,
            settings.max_video_seconds,
        )
        logger.info("Prepared %d video frame(s) for recognition", len(frames))
        if not settings.openai_api_key:
            return ScanResponse(
                ingredients=demo_inventory(),
                frames_analyzed=len(frames),
                demo_mode=True,
                notice=(
                    "Demo inventory shown. Add OPENAI_API_KEY on the API server "
                    "to analyze your own video."
                ),
            )
        ingredients = await _run_while_connected(
            request,
            recognize_frames(
                frames,
                settings.openai_api_key,
                settings.openai_model,
                settings.openai_timeout_seconds,
                openai_client,
                image_detail="high",
            ),
        )
        logger.info("Pantry video scan completed: ingredients=%d", len(ingredients))
        return ScanResponse(ingredients=ingredients, frames_analyzed=len(frames), demo_mode=False)
    except ValueError as error:
        raise HTTPException(
            status_code=502,
            detail="Recognition returned an unreadable result. Please retry with steadier footage.",
        ) from error
    except (APITimeoutError, APIConnectionError, APIStatusError) as error:
        logger.exception("Video recognition provider failure")
        raise _openai_failure(error, "video recognition") from error
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Video recognition failed")
        raise HTTPException(
            status_code=502,
            detail=(
                "Video analysis failed on the server. Check OPENAI_API_KEY "
                "and the server log, then retry."
            ),
        ) from error
    finally:
        path.unlink(missing_ok=True)


@app.post("/v1/plan", response_model=PlanResponse)
async def make_plan(request: PlanRequest, http_request: Request) -> PlanResponse:
    settings = get_settings()
    logger.info(
        "Recipe-plan request received: ingredients=%d cuisine=%s api_configured=%s",
        len(request.ingredients),
        request.cuisine,
        bool(settings.openai_api_key),
    )
    try:
        return await _run_while_connected(
            http_request,
            create_plan(
                request,
                settings,
                getattr(http_request.app.state, "openai_client", None),
            ),
        )
    except ValueError as error:
        raise HTTPException(
            status_code=502,
            detail="Recipe planning returned an unreadable result. Please try again.",
        ) from error
    except (APITimeoutError, APIConnectionError, APIStatusError) as error:
        logger.exception("Recipe planning provider failure")
        raise _openai_failure(error, "recipe planning") from error
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Recipe planning failed")
        raise HTTPException(
            status_code=502,
            detail="Recipe planning failed on the server. Retry shortly.",
        ) from error


@app.post("/v1/stores", response_model=StoreLookupResponse)
async def find_stores(
    request: StoreLookupRequest,
    http_request: Request,
) -> StoreLookupResponse:
    """Resolve current store offers without generating another recipe."""
    settings = get_settings()
    try:
        result = await _run_while_connected(
            http_request,
            lookup_store_offers(settings, request.items, request.location),
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Store lookup failed")
        raise HTTPException(
            status_code=502,
            detail="Store lookup failed on the server. Retry shortly.",
        ) from error
    return StoreLookupResponse(
        stores=result.stores,
        shopping_notice=result.shopping_notice,
    )


@app.post("/v1/recipe-images", response_model=RecipeImageResponse)
async def recipe_image(
    request: RecipeImageRequest,
    http_request: Request,
) -> RecipeImageResponse:
    settings = get_settings()
    provider = GeneratedRecipeImageProvider(
        settings,
        getattr(http_request.app.state, "openai_client", None),
    )
    image = await _run_while_connected(http_request, provider.find(request.title))
    return RecipeImageResponse(image=image)
