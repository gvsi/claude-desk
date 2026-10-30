// CloudFront Function (cloudfront-js-2.0), viewer request, on the web app's behavior only.
// The web app routes in the browser (/d/<slug>, /pay/<token>, /app/...), so any path under /app/
// and any other path whose last segment has no dot is served /index.html. Nothing under /app/ is a
// file, and the owner's tool pages end in a dotted tool name (payments.create_refund). Files such as
// /assets/app-1a2b.js pass through. /api/* never reaches this function, so API errors are never
// masked by the app's page.
function handler(event) {
  const request = event.request;
  const lastSegment = request.uri.slice(request.uri.lastIndexOf("/") + 1);
  if (request.uri.startsWith("/app/") || !lastSegment.includes(".")) {
    request.uri = "/index.html";
  }
  return request;
}
