/**
 * What an About this prototype page shows while its code loads on a first visit: the set's paper, empty, so the
 * page opens on the ground it is drawn on rather than the app's dark one. It loads with the app, as the error page
 * does, and brings only the paper's stylesheet.
 */
import './paper.css';

export function AboutWait() {
  return <div className="cd-about-paper cd-about-paper--app" />;
}
