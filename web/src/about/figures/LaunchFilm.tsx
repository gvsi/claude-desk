/**
 * The product proposal's lead figure: the Claude Desk launch film, about two minutes with music and no voice, in the
 * browser's own player. It starts only when a reader plays it, since its music carries it, and reads just the film's
 * length and size until then. One 1080p file serves every width.
 *
 * The film and its poster load through the build, so each file's name carries a hash of its content and a new cut
 * reaches readers whose browsers keep the old one (the site caches its build's files for a year). The player holds
 * its 16:9 space from the first frame (`reader.css`), so nothing moves as the poster and the film arrive. The words
 * under it say what the film shows, for anyone who can't watch or hear it, and describe the player.
 */
import { useId } from 'react';

import film from '../media/launch-film-1080.mp4';
import poster from '../media/launch-film-poster.jpg';

import '../reader.css';

/** The film's words: the player's name, and what the film shows. */
const LAUNCH_FILM = {
  name: 'Claude Desk launch film, 2 minutes',
  shows:
    'Mike’s Desk quotes and books a repair at 11:46 pm, asks Mike before an emergency visit, takes a booking and ' +
    'deposit from a customer’s AI assistant within the limit they signed, and won’t be talked into a refund. Music, no voice.',
} as const;

export interface LaunchFilmProps {
  /** The phone layout: the caption in the phone's caption type. */
  compact?: boolean;
}

export function LaunchFilm({ compact = false }: LaunchFilmProps) {
  const showsId = useId();
  return (
    <figure className={`cd-about-figure cd-about-film${compact ? ' cd-about-figure--compact' : ''}`}>
      {/* The frame draws keyboard focus over the picture (`reader.css`). */}
      <div className="cd-about-film__frame">
        <video
          className="cd-about-film__player"
          poster={poster}
          controls
          playsInline
          preload="metadata"
          aria-label={LAUNCH_FILM.name}
          aria-describedby={showsId}
        >
          <source src={film} type="video/mp4" />
        </video>
      </div>
      <figcaption className={`cd-about-figcaption ${compact ? 'cd-type-caption' : 'cd-type-article-caption'}`}>
        <span id={showsId}>{LAUNCH_FILM.shows}</span>
      </figcaption>
    </figure>
  );
}
