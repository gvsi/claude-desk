// CloudFront Function (cloudfront-js-2.0), viewer request, on the web app's behavior only.
// The web app routes in the browser (/d/<slug>, /pay/<token>), so any path whose last segment
// has no dot is served /index.html; files such as /assets/app-1a2b.js pass through. /api/* never
// reaches this function, so API errors are never masked by the app's page.
function handler(event) {
  const request = event.request;
  const lastSegment = request.uri.slice(request.uri.lastIndexOf("/") + 1);
  if (!lastSegment.includes(".")) {
    request.uri = "/index.html";
  }
  return request;
}
