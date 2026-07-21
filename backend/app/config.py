"""Application configuration loaded from environment variables."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated runtime settings for the API process."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str | None = None
    openai_model: str = Field(default="gpt-5.6", min_length=1, max_length=80)
    openai_timeout_seconds: float = Field(default=300.0, ge=30, le=600)
    max_upload_mb: int = Field(default=28, ge=1, le=500)
    max_image_upload_mb: int = Field(default=7, ge=1, le=50)
    max_images: int = Field(default=4, ge=1, le=10)
    max_video_seconds: int = Field(default=35, ge=1, le=180)
    max_frames: int = Field(default=8, ge=1, le=20)
    google_maps_api_key: str | None = None
    google_places_search_url: str = "https://places.googleapis.com/v1/places:searchNearby"
    serpapi_api_key: str | None = None
    serpapi_search_url: str = "https://serpapi.com/search.json"
    serpapi_country: str = Field(default="us", min_length=2, max_length=2)
    serpapi_language: str = Field(default="en", min_length=2, max_length=2)
    recipe_image_model: str = "gpt-image-2"
    recipe_image_size: str = Field(default="816x816", pattern=r"^[1-9]\d{1,3}x[1-9]\d{1,3}$")
    recipe_image_timeout_seconds: float = Field(default=35.0, ge=10, le=120)
    cors_allowed_origins: str = "http://localhost:8081,http://localhost:19006"
    allowed_hosts: str = "*"
    app_check_enforced: bool = False
    app_check_project_id: str | None = None
    app_check_allowed_app_ids: str = ""

    @property
    def cors_origins(self) -> list[str]:
        """Return normalized CORS origins from a comma-separated setting."""
        return _split_csv(self.cors_allowed_origins)

    @property
    def trusted_hosts(self) -> list[str]:
        """Return normalized trusted hosts from a comma-separated setting."""
        return _split_csv(self.allowed_hosts) or ["*"]

    @property
    def app_check_allowed_ids(self) -> list[str]:
        """Return the Firebase App IDs allowed to call protected endpoints."""
        return _split_csv(self.app_check_allowed_app_ids)


def _split_csv(value: str) -> list[str]:
    """Split a small comma-separated environment setting."""
    return list(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))


@lru_cache
def get_settings() -> Settings:
    return Settings()
