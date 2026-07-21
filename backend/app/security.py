"""Request security helpers for verified mobile application traffic."""

from functools import lru_cache

import firebase_admin
from firebase_admin import app_check


class AppCheckVerificationError(Exception):
    """Raised when a request does not carry a valid PantryPilot App Check token."""


@lru_cache
def _firebase_app(project_id: str):
    """Return the process-scoped Firebase Admin application for a project."""
    try:
        return firebase_admin.get_app()
    except ValueError:
        return firebase_admin.initialize_app(options={"projectId": project_id})


def verify_app_check_token(token: str, project_id: str) -> dict[str, object]:
    """Verify an App Check JWT and return its claims without logging the token."""
    try:
        return app_check.verify_token(token, app=_firebase_app(project_id))
    except Exception as error:
        raise AppCheckVerificationError("App Check token verification failed.") from error
