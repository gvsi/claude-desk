"""The API's two cookies. They carry only kernel tokens, unsigned (the kernel checks the token), and are
`HttpOnly; Secure; SameSite=Strict` with no `Domain`, so they stay first-party (Plan 02a, "Cookies").

- `desk_owner`: the owner token, sent only to `/api/owner` paths, for 7 days.
- `desk_visitor`: a visitor session token, sent only to its Desk's `/api/public/desks/{slug}` paths, for 24 hours,
  renewed on each request: the kernel closes a session after 24 hours idle.
"""

import re
from urllib.parse import quote

from fastapi import Response

OWNER_COOKIE = "desk_owner"
VISITOR_COOKIE = "desk_visitor"
OWNER_PATH = "/api/owner"
OWNER_MAX_AGE_S = 7 * 24 * 3600
VISITOR_MAX_AGE_S = 24 * 3600
_TOKEN = re.compile(r"[A-Za-z0-9_\-]{16,512}")    # a kernel token (token_urlsafe): nothing to quote or escape


def _set_cookie(response: Response, name: str, value: str, path: str, max_age: int) -> None:
    response.headers.append(
        "set-cookie", f"{name}={value}; HttpOnly; Secure; SameSite=Strict; Path={path}; Max-Age={max_age}")


def _token(token: str) -> str:
    if not isinstance(token, str) or not _TOKEN.fullmatch(token):
        raise ValueError("a cookie holds a kernel token")      # the value is never quoted back
    return token


def visitor_path(slug: str) -> str:
    """The path the visitor cookie for `slug` is sent to: that Desk's routes only."""
    if not isinstance(slug, str) or not slug:
        raise ValueError("a visitor cookie names its Desk's slug")
    return f"/api/public/desks/{quote(slug, safe='')}"


def set_owner_cookie(response: Response, token: str) -> None:
    _set_cookie(response, OWNER_COOKIE, _token(token), OWNER_PATH, OWNER_MAX_AGE_S)


def set_visitor_cookie(response: Response, slug: str, token: str) -> None:
    _set_cookie(response, VISITOR_COOKIE, _token(token), visitor_path(slug), VISITOR_MAX_AGE_S)


def clear_visitor_cookie(response: Response, slug: str) -> None:
    _set_cookie(response, VISITOR_COOKIE, "", visitor_path(slug), 0)
