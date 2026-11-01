/**
 * Where each vision page lives. Its own module, holding nothing else, so a page that only links to the vision
 * pages (the Vision article's picture cards) loads none of their fixed data.
 */
export const VISION_PATHS = {
  cityOffice: '/vision/city-office',
  teamDesk: '/vision/team-desk',
  claudeAccount: '/vision/claude-account',
  phone: '/vision/phone',
} as const;
