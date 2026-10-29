"""Write the API's OpenAPI document, desk/api/openapi.json: the HTTP contract the web app's client is built from.

Run from backend/ after adding or changing a route: uv run python scripts/export_openapi.py
Operation IDs read `<router>_<name>`, and every error answer is an `ApiError`. The app is built from placeholder
settings and never started, so this reads no environment and opens no connection.
"""

import json
from pathlib import Path

from desk.api.main import create_app
from desk.api.settings import Settings

OPENAPI_PATH = Path(__file__).resolve().parent.parent / "desk" / "api" / "openapi.json"
PLACEHOLDER_SETTINGS = Settings(api_database_url="postgresql+psycopg://openapi@127.0.0.1/openapi", desk_env="test")


def export_openapi() -> dict:
    """The app's OpenAPI document."""
    return create_app(PLACEHOLDER_SETTINGS).openapi()


def main() -> None:
    OPENAPI_PATH.write_text(json.dumps(export_openapi(), indent=2) + "\n")


if __name__ == "__main__":
    main()
