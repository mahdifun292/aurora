import { icon } from './icons.js';
import {
  esc, fmtTime, fmtLong, coverHTML, fmtCount, greeting, hashString,
} from './util.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function ctx(state, key, tracks) {
  let finalKey = key;
  let n = 2;
  while (state.contexts.has(finalKey) && state.contexts.get(finalKey) !== tracks) {
    finalKey = `${key}#${n}`;
    n += 1;
  }
  state.contexts.set(finalKey, tracks);
  return finalKey;
}

function totalTime(tracks) {
  return (tracks || []).reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
}

function isFav(state, track) {
  return Boolean(track?.starred) || Boolean(state.favIds?.has(track?.id));
}

function quality(track) {
  const ext = (track.path || '').split('.').pop().toLowerCase();
  if (['flac', 'wav', 'aiff', 'aif'].includes(ext)) return ext === 'flac' ? 'FLAC' : 'LOSSLESS';
  if ((track.codec || '').toLowerCase() === 'flac') return 'FLAC';
  const br = Number(track.bitrate) || 0;
  if (br >= 900000) return 'HI-RES';
  if (br >= 256000) return 'HQ';
  if (br >= 128000) return 'MP3';
  return '';
}

function playBtn(label, action, attrs = '', iconName = 'play') {
  return `<button class="btn btn-primary" data-action="${action}" ${attrs}>${icon(iconName)}<span>${esc(label)}</span></button>`;
}

function emptyState({ iconName = 'music', title, text, action = '', secondary = '' }) {
  return `<div class="empty-state">
    <div class="empty-art">${icon(iconName)}</div>
    <h2>${esc(title)}</h2>
    <p>${text}</p>
    ${action ? `<div class="row" style="margin-top:22px">${action}${secondary}</div>` : ''}
  </div>`;
}

function sectionHead(title, hint = '', link = '') {
  return `<div class="section-head-row">
    <div><h2>${esc(title)}</h2>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>
    ${link}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* pieces                                                              */
/* ------------------------------------------------------------------ */

export function trackRow(state, track, ctxKey, index, opts = {}) {
  const current = state.currentId === track.id;
  const fav = isFav(state, track);
  const q = quality(track);
  const selectable = Boolean(opts.selectable);
  const selected = selectable && Boolean(state.selectedSongIds?.has(track.id));
  const reorderable = Boolean(opts.reorderable);
  return `<div class="track-row ${current ? 'current' : ''} ${selected ? 'selected' : ''}" data-ctx="${esc(ctxKey)}" data-idx="${index}" data-track-id="${esc(track.id)}" role="button" tabindex="-1"${reorderable ? ' draggable="true" data-reorder="playlist"' : ''}>
    ${selectable ? `<div class="tr-select"><button class="tr-check ${selected ? 'on' : ''}" data-action="select-track" data-track-id="${esc(track.id)}" aria-pressed="${selected}" title="${selected ? 'Deselect' : 'Select'}">${icon('check')}</button></div>` : ''}
    <div class="tr-num">
      ${reorderable ? `<span class="tr-grip" title="Drag to reorder">${icon('rows')}</span>` : ''}
      <span class="num">${index + 1}</span>
      <span class="tr-play-ico">${icon('play')}</span>
      <span class="row-eq"><i></i><i></i><i></i></span>
    </div>
    ${opts.noCover ? '' : `<div class="tr-cover">${coverHTML(track, { lazy: true })}</div>`}
    <div class="tr-main">
      <div class="tr-title">${esc(track.title)}${fav ? `<span class="tr-fav" style="display:inline-flex;vertical-align:-3px;margin-left:6px">${icon('heart')}</span>` : ''}</div>
      <div class="tr-artist">${esc(track.artist || 'Unknown Artist')}</div>
    </div>
    <div class="tr-album">${opts.hideAlbum ? '' : esc(track.album || '')}</div>
    <div class="tr-badge">${q ? `<span class="tr-quality">${q}</span>` : ''}</div>
    <div class="tr-dur">${fmtTime(track.duration)}</div>
    <button class="tr-more" data-action="track-menu" data-ctx="${esc(ctxKey)}" data-idx="${index}" title="More options" aria-label="More options">${icon('more')}</button>
  </div>`;
}

export function trackList(state, tracks, key, opts = {}) {
  if (!tracks.length) {
    return `<div class="empty-state" style="padding:48px 20px">
      <div class="empty-art" style="width:64px;height:64px;border-radius:18px">${icon(opts.emptyIcon || 'music')}</div>
      <h2 style="font-size:17px">${esc(opts.emptyTitle || 'Nothing here yet')}</h2>
      <p style="font-size:12px">${esc(opts.emptyText || '')}</p>
    </div>`;
  }
  const ctxKey = ctx(state, key, tracks);
  return `<div class="track-list ${opts.flush ? 'flush' : ''} ${opts.noCover ? 'no-cover' : ''} ${opts.hideAlbum ? 'no-album' : ''} ${opts.selectable ? 'selectable' : ''} ${opts.reorderable ? 'reorderable' : ''}">
    ${tracks.map((t, i) => trackRow(state, t, ctxKey, i, opts)).join('')}
  </div>`;
}

export function albumCard(state, album, opts = {}) {
  const sub = [album.artist, album.year].filter(Boolean).join(' · ');
  return `<article class="album-card" data-action="open-album" data-album-id="${esc(album.id)}" data-source="${esc(album.source || 'local')}" title="${esc(album.name)}">
    <div class="card-art">
      ${coverHTML(album, { lazy: true })}
      <button class="card-play" data-action="play-album" data-album-id="${esc(album.id)}" data-source="${esc(album.source || 'local')}" title="Play album" aria-label="Play ${esc(album.name)}">${icon('play')}</button>
    </div>
    <div class="card-title">${esc(album.name)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </article>`;
}

export function artistCard(artist) {
  return `<article class="artist-card" data-action="open-artist" data-artist-id="${esc(artist.id)}" data-source="${esc(artist.source || 'local')}">
    <div class="artist-avatar">${coverHTML(artist, { lazy: true })}</div>
    <div class="card-title">${esc(artist.name)}</div>
    <div class="card-sub">${artist.albumCount ? `${artist.albumCount} album${artist.albumCount === 1 ? '' : 's'}` : 'Artist'}</div>
  </article>`;
}

function playlistArt(state, playlist, className = '') {
  const tracks = playlist.tracks || [];
  if (playlist.coverUrl && !tracks.length) {
    return `<div class="pl-art ${className}"><div class="cover"><img src="${esc(playlist.coverUrl)}" loading="lazy" alt="" /></div></div>`;
  }
  const covers = tracks.map((t) => t.coverUrl).filter(Boolean).slice(0, 4);
  if (!covers.length) {
    return `<div class="pl-art ${className}">${coverHTML({ name: playlist.name }, { lazy: true })}</div>`;
  }
  while (covers.length < 4) covers.push(covers[covers.length - 1]);
  return `<div class="pl-art ${className}"><div class="pl-collage">
    ${covers.map((c) => `<div class="cover"><img src="${esc(c)}" loading="lazy" alt="" /></div>`).join('')}
  </div></div>`;
}

export function playlistCard(state, playlist) {
  const count = playlist.tracks?.length ?? playlist.songCount ?? 0;
  return `<article class="playlist-card" data-action="open-playlist" data-playlist-id="${esc(playlist.id)}" data-source="${esc(playlist.source || 'local')}">
    ${playlistArt(state, playlist)}
    <div class="pl-info">
      <div class="pl-name">${esc(playlist.name)}</div>
      <div class="pl-sub">${count} song${count === 1 ? '' : 's'}${playlist.source === 'server' ? ' · Server' : ''}</div>
    </div>
    <span class="muted">${icon('chevronRight')}</span>
  </article>`;
}

function detailHead({ eyebrow, title, art, meta, actions, extra = '', artClass = '' }) {
  return `<header class="detail-head">
    <div class="detail-art ${artClass}">${art}</div>
    <div class="detail-info">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h1>${esc(title)}</h1>
      <div class="detail-meta">${meta}</div>
      <div class="detail-actions">${actions}</div>
      ${extra}
    </div>
  </header>`;
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

function picksFor(state, tracks, limit) {
  const day = new Date().toDateString();
  return [...tracks]
    .map((t) => ({ t, h: hashString(`${day}:${t.id}`) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, limit)
    .map((x) => x.t);
}

export function home(state) {
  const source = state.source;
  if (source === 'server') {
    if (!state.serverConnected) {
      return emptyState({
        iconName: 'server',
        title: 'Connect your music server',
        text: 'Aurora works with Navidrome, Subsonic, Airsonic, Gonic and other Subsonic-compatible servers. Add your server in settings to stream your whole library.',
        action: `<button class="btn btn-primary" data-route="settings">${icon('settings')} Open settings</button>`,
      });
    }
    const albums = state.serverNewest.length ? state.serverNewest : state.serverAlbums;
    const stats = {
      albums: state.serverAlbums.length,
      artists: state.serverArtists.length,
      tracks: state.serverAlbums.reduce((s, a) => s + (a.songCount || 0), 0),
      hours: '',
    };
    return heroAndSections(state, albums, state.serverRandom || [], stats, true);
  }

  const albums = state.localAlbums;
  const tracks = state.tracks;

  if (!albums.length) {
    if (!state.settings.libraryFolders.length) {
      return emptyState({
        iconName: 'folder',
        title: 'Your library is waiting',
        text: 'Point Aurora at a folder of music. It reads MP3, FLAC, M4A, OGG, OPUS, WAV and more — including embedded artwork and lyrics.',
        action: `<button class="btn btn-primary" data-action="add-folder">${icon('folder')} Choose music folder</button>`,
        secondary: `<button class="btn btn-soft" data-action="connect-server">${icon('server')} Use a server</button>`,
      });
    }
    return emptyState({
      iconName: 'music',
      title: 'No tracks found',
      text: 'We looked through your folders but did not find any playable audio. Add another folder or run the scan again.',
      action: `<button class="btn btn-primary" data-action="scan-library">${icon('refresh')} Rescan library</button>`,
      secondary: `<button class="btn btn-soft" data-action="add-folder">${icon('folder')} Add folder</button>`,
    });
  }

  const stats = {
    albums: albums.length,
    artists: state.localArtists.length,
    tracks: tracks.length,
    hours: fmtLong(totalTime(tracks)),
  };
  return heroAndSections(state, albums, tracks, stats, false);
}

function heroAndSections(state, albums, tracks, stats, server) {
  const recentAlbums = (state.recentAlbumIds || [])
    .map((id) => albums.find((a) => a.id === id))
    .filter(Boolean)
    .slice(0, 10);
  const jumpBack = recentAlbums.length ? recentAlbums : albums.slice(0, 10);
  const recentAdded = server
    ? albums.slice(0, 12)
    : [...albums].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
  const picks = tracks.length ? picksFor(state, tracks, 6) : [];
  const featured = recentAlbums[0] || recentAdded[0] || albums[0];

  const hero = `<section class="hero">
    <div class="hero-copy">
      <div class="hero-greeting">${esc(greeting())} · ${server ? 'from your server' : 'from your library'}</div>
      <h1>${server ? 'Your whole collection, in full colour.' : 'Your music, in full colour.'}</h1>
      <p>${server
        ? 'Streaming straight from your server with synced lyrics, a living queue and artwork that sets the mood.'
        : 'A calm, beautiful place for your collection — with synced lyrics, rich artwork and a player that feels alive.'}</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-action="shuffle-all">${icon('shuffle')} Shuffle everything</button>
        <button class="btn btn-soft" data-route="albums">${icon('disc')} Browse albums</button>
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><strong>${fmtCount(stats.tracks)}</strong><span>Tracks</span></div>
        <div class="hero-stat"><strong>${fmtCount(stats.albums)}</strong><span>Albums</span></div>
        <div class="hero-stat"><strong>${fmtCount(stats.artists)}</strong><span>Artists</span></div>
        ${stats.hours ? `<div class="hero-stat"><strong>${stats.hours}</strong><span>Playing time</span></div>` : ''}
      </div>
    </div>
    <div class="hero-art">
      <div class="vinyl"></div>
      <div class="hero-cover">${featured ? coverHTML(featured) : ''}</div>
      <div class="floating-note">${icon('sparkles')}</div>
    </div>
  </section>`;

  const jumpSection = jumpBack.length ? `
    <div class="section-head-row">
      <div><h2>Jump back in</h2><div class="hint">${recentAlbums.length ? 'Based on your listening' : 'A few favourites to start with'}</div></div>
      <button class="section-link" data-route="albums">All albums ${icon('chevronRight')}</button>
    </div>
    <div class="hrow">${jumpBack.map((a) => albumCard(state, a)).join('')}</div>` : '';

  const recentSection = recentAdded.length ? `
    <div class="section-head-row">
      <div><h2>${server ? 'New on the server' : 'Recently added'}</h2><div class="hint">${server ? 'Fresh albums from your collection' : 'The newest music in your folders'}</div></div>
      <button class="section-link" data-route="albums">Browse ${icon('chevronRight')}</button>
    </div>
    <div class="hrow">${recentAdded.map((a) => albumCard(state, a)).join('')}</div>` : '';

  const mixSection = picks.length ? `
    <div class="section-head-row">
      <div><h2>${icon('sparkles')} Made for you</h2><div class="hint">A handful of tracks picked for today</div></div>
      <button class="section-link" data-action="play-mix">Play all ${icon('play')}</button>
    </div>
    ${trackList(state, picks, 'home:mix', { flush: true, noCover: false })}` : '';

  const localPlaylists = state.playlists.filter((p) => p.tracks?.length).slice(0, 4);
  const playlistSection = localPlaylists.length ? `
    <div class="section-head-row">
      <div><h2>Your playlists</h2><div class="hint">Handmade collections</div></div>
      <button class="section-link" data-route="playlists">All playlists ${icon('chevronRight')}</button>
    </div>
    <div class="playlist-grid">${localPlaylists.map((p) => playlistCard(state, p)).join('')}</div>` : '';

  const artists = server ? state.serverArtists.slice(0, 8) : state.localArtists.slice(0, 8);
  const artistSection = artists.length ? `
    <div class="section-head-row">
      <div><h2>Artists to explore</h2><div class="hint">Voices behind the records</div></div>
      <button class="section-link" data-route="artists">All artists ${icon('chevronRight')}</button>
    </div>
    <div class="artist-grid">${artists.map((a) => artistCard(a)).join('')}</div>` : '';

  return `${hero}${jumpSection}${recentSection}${mixSection}${playlistSection}${artistSection}`;
}

/* ------------------------------------------------------------------ */
/* Albums / artists / playlists                                        */
/* ------------------------------------------------------------------ */

export function albums(state) {
  const list = state.source === 'server' ? state.serverAlbums : state.localAlbums;
  if (!list.length) {
    return emptyState({
      iconName: 'disc',
      title: state.source === 'server' ? 'No albums on the server' : 'No albums yet',
      text: state.source === 'server' ? 'Your server responded but did not return any albums.' : 'Scan your music folders to build your library.',
      action: `<button class="btn btn-primary" data-action="${state.source === 'server' ? 'reload-server' : 'scan-library'}">${icon('refresh')} ${state.source === 'server' ? 'Reload' : 'Scan library'}</button>`,
    });
  }
  const sorted = sortAlbums(list, state.albumSort);
  const head = `<div class="page-head">
    <div class="eyebrow">Library</div>
    <h1>Albums</h1>
    <div class="sub">${list.length} album${list.length === 1 ? '' : 's'} · ${state.source === 'server' ? 'streaming from your server' : 'stored on this computer'}</div>
  </div>`;

  if (state.albumMode === 'list') {
    const rows = sorted.map((a, i) => {
      const sub = [a.artist, a.year].filter(Boolean).join(' · ');
      return `<div class="album-row" data-action="open-album" data-album-id="${esc(a.id)}" data-source="${esc(a.source)}" style="animation:rowIn .35s var(--ease) both;animation-delay:${Math.min(i, 20) * 12}ms">
        <div class="row-art">${coverHTML(a, { lazy: true })}</div>
        <div><div class="row-title">${esc(a.name)}</div><div class="row-sub">${esc(sub)}</div></div>
        <div class="row-meta">${esc(a.artist || '')}</div>
        <div class="row-meta">${a.songCount ? `${a.songCount} songs` : ''}</div>
        <div class="row-meta">${a.year || ''}</div>
        <button class="row-play" data-action="play-album" data-album-id="${esc(a.id)}" data-source="${esc(a.source)}" title="Play">${icon('play')}</button>
      </div>`;
    }).join('');
    return `${head}<div class="album-list">${rows}</div>`;
  }

  return `${head}<div class="album-grid">${sorted.map((a) => albumCard(state, a)).join('')}</div>`;
}

function sortAlbums(list, mode) {
  const arr = [...list];
  switch (mode) {
    case 'artist':
      return arr.sort((a, b) => String(a.artist).localeCompare(String(b.artist)) || String(a.name).localeCompare(String(b.name)));
    case 'year':
      return arr.sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(String(b.name)));
    case 'recent':
      return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || String(a.name).localeCompare(String(b.name)));
    default:
      return arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
}

export function artists(state) {
  const list = state.source === 'server' ? state.serverArtists : state.localArtists;
  if (!list.length) {
    return emptyState({
      iconName: 'mic',
      title: 'No artists yet',
      text: 'Artists appear here once your library has been scanned.',
      action: `<button class="btn btn-primary" data-action="${state.source === 'server' ? 'reload-server' : 'scan-library'}">${icon('refresh')} ${state.source === 'server' ? 'Reload' : 'Scan library'}</button>`,
    });
  }
  const head = `<div class="page-head">
    <div class="eyebrow">Library</div>
    <h1>Artists</h1>
    <div class="sub">${list.length} artist${list.length === 1 ? '' : 's'}</div>
  </div>`;
  return `${head}<div class="artist-grid">${[...list].sort((a, b) => a.name.localeCompare(b.name)).map((a) => artistCard(a)).join('')}</div>`;
}

export function playlists(state) {
  const list = state.source === 'server' ? state.serverPlaylists : state.playlists;
  const head = `<div class="page-head">
    <div class="eyebrow">Collections</div>
    <h1>Playlists</h1>
    <div class="sub">${list.length} playlist${list.length === 1 ? '' : 's'}${state.source === 'server' ? ' · from your server' : ' · saved on this computer'}</div>
  </div>`;

  if (!list.length) {
    return `${head}${emptyState({
      iconName: 'listMusic',
      title: state.source === 'server' ? 'No server playlists' : 'Make your first playlist',
      text: state.source === 'server'
        ? 'Create playlists in Navidrome or your Subsonic client and they will show up here.'
        : 'Collect the tracks that belong together. Open any song menu and choose “Add to playlist”.',
      action: state.source === 'server' ? '' : `<button class="btn btn-primary" data-action="new-playlist">${icon('plus')} New playlist</button>`,
    })}`;
  }

  return `${head}<div class="playlist-grid">${list.map((p) => playlistCard(state, p)).join('')}</div>`;
}

export function playlist(state, pl, tracks) {
  const duration = totalTime(tracks);
  const art = tracks.length && tracks[0].coverUrl
    ? `<div class="cover"><img src="${esc(tracks[0].coverUrl)}" alt="" /></div>`
    : coverHTML({ name: pl.name });
  const isLocal = pl.source !== 'server';
  return `${detailHead({
    eyebrow: isLocal ? 'Playlist' : 'Server playlist',
    title: pl.name,
    art,
    meta: `<strong>${tracks.length}</strong> songs <span class="dot"></span> ${fmtLong(duration) || '—'} ${isLocal ? '<span class="dot"></span> saved locally' : ''}`,
    actions: `${playBtn('Play', 'play-playlist', `data-playlist-id="${esc(pl.id)}"`)}
      <button class="btn btn-soft" data-action="shuffle-playlist" data-playlist-id="${esc(pl.id)}">${icon('shuffle')} Shuffle</button>
      ${isLocal ? `<button class="btn btn-soft" data-action="playlist-add-songs" data-playlist-id="${esc(pl.id)}">${icon('plus')} Add songs</button>
      <button class="btn btn-ghost" data-action="rename-playlist" data-playlist-id="${esc(pl.id)}">${icon('pencil')} Rename</button>
      <button class="btn btn-ghost" data-action="delete-playlist" data-playlist-id="${esc(pl.id)}" style="color:#f87171">${icon('trash')}</button>` : ''}`,
    extra: isLocal
      ? `<div class="detail-sub">${pl.createdAt ? `Created ${new Date(pl.createdAt).toLocaleDateString()}` : 'Your local playlist'}<span class="spacer"></span><span class="reorder-hint">${icon('rows')} Drag songs to reorder</span></div>`
      : '<div class="detail-sub">Server playlists are read-only in Aurora</div>',
  })}
  ${trackList(state, tracks, `playlist:${pl.id}`, { reorderable: isLocal, emptyTitle: 'This playlist is empty', emptyText: 'Use Add songs or the song menu to add tracks.', emptyIcon: 'listMusic' })}`;
}

export function favorites(state, tracks, serverNote = '') {
  const head = `<div class="page-head">
    <div class="eyebrow">Loved</div>
    <h1>Favorites</h1>
    <div class="sub">${tracks.length} song${tracks.length === 1 ? '' : 's'} ${serverNote || 'you have marked with a heart'}</div>
  </div>`;
  if (!tracks.length) {
    return `${head}${emptyState({
      iconName: 'heart',
      title: 'Songs you love',
      text: state.source === 'server'
        ? 'Star songs in Navidrome or with the heart in Aurora and they will appear here.'
        : 'Tap the heart on any track and it will be waiting for you here.',
    })}`;
  }
  return `${head}
    <div class="row" style="margin-bottom:18px">
      ${playBtn('Play all', 'play-favorites')}
      <button class="btn btn-soft" data-action="shuffle-favorites">${icon('shuffle')} Shuffle</button>
    </div>
    ${trackList(state, tracks, 'favorites', {})}`;
}

/* ------------------------------------------------------------------ */
/* All songs                                                           */
/* ------------------------------------------------------------------ */

export function songSortLabel(mode) {
  switch (mode) {
    case 'artist': return 'Artist';
    case 'album': return 'Album';
    case 'recent': return 'Recently added';
    case 'duration': return 'Duration';
    default: return 'Title';
  }
}

export function sortSongs(list, mode = 'title') {
  const arr = [...(list || [])];
  const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
  switch (mode) {
    case 'artist':
      return arr.sort((a, b) => String(a.artist || '').localeCompare(String(b.artist || '')) || byTitle(a, b));
    case 'album':
      return arr.sort((a, b) => String(a.album || '').localeCompare(String(b.album || '')) || (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) || byTitle(a, b));
    case 'recent':
      return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || byTitle(a, b));
    case 'duration':
      return arr.sort((a, b) => (b.duration || 0) - (a.duration || 0) || byTitle(a, b));
    default:
      return arr.sort(byTitle);
  }
}

export function songs(state) {
  const isServer = state.source === 'server';
  const list = isServer ? (state.serverSongs || []) : (state.tracks || []);
  const sorted = sortSongs(list, state.songSort);
  const duration = totalTime(list);
  const head = `<div class="page-head">
    <div class="eyebrow">Library</div>
    <h1>Songs</h1>
    <div class="sub">${list.length} song${list.length === 1 ? '' : 's'} · ${fmtLong(duration) || '0 min'} ${isServer ? '· streaming from your server' : '· stored on this computer'}</div>
  </div>`;

  if (!list.length) {
    const failed = isServer && state.serverSongsError;
    return `${head}${emptyState({
      iconName: failed ? 'wifiOff' : 'music',
      title: failed ? 'Could not load songs' : isServer ? 'No songs on the server' : 'No songs yet',
      text: failed
        ? esc(state.serverSongsError)
        : isServer
          ? 'Your server responded but did not return any songs.'
          : 'Add a music folder and scan your library to see every song in one place.',
      action: `<button class="btn btn-primary" data-action="${isServer ? 'reload-server' : 'scan-library'}">${icon('refresh')} ${isServer ? 'Try again' : 'Scan library'}</button>`,
    })}`;
  }

  return `${head}
    <div class="songs-actions">
      ${playBtn('Play all', 'play-all-songs')}
      <button class="btn btn-soft" data-action="shuffle-all-songs">${icon('shuffle')} Shuffle</button>
      <button class="btn btn-ghost ${state.selectionMode ? 'is-active' : ''}" data-action="toggle-select-mode">${icon('check')} ${state.selectionMode ? 'Done' : 'Select'}</button>
      <span class="songs-actions-spacer"></span>
      <label class="filter-field" for="songs-filter">
        ${icon('search')}
        <input id="songs-filter" type="text" placeholder="Filter songs…" autocomplete="off" spellcheck="false" value="${esc(state.songFilter || '')}" />
      </label>
    </div>
    <div id="songs-list">${trackList(state, sorted, 'songs', { selectable: state.selectionMode })}</div>
    <div id="songs-no-match" class="songs-no-match" hidden>
      ${icon('search')}<span>No songs match your filter.</span>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Detail pages                                                        */
/* ------------------------------------------------------------------ */

export function album(state, album) {
  const tracks = album.tracks || [];
  const duration = totalTime(tracks);
  const artistId = album.artistId || (album.source === 'server' ? '' : `local:artist:${album.artist}`);
  const meta = [
    `<strong>${esc(album.artist || 'Unknown Artist')}</strong>`,
    album.year ? `<span class="dot"></span>${album.year}` : '',
    `<span class="dot"></span>${tracks.length} songs`,
    duration ? `<span class="dot"></span>${fmtLong(duration)}` : '',
    album.source === 'server' ? '<span class="dot"></span>Streaming' : '',
  ].filter(Boolean).join(' ');

  return `${detailHead({
    eyebrow: 'Album',
    title: album.name,
    art: coverHTML(album),
    meta,
    actions: `${playBtn('Play', 'play-album', `data-album-id="${esc(album.id)}" data-source="${esc(album.source)}"`)}
      <button class="btn btn-soft" data-action="shuffle-album" data-album-id="${esc(album.id)}" data-source="${esc(album.source)}">${icon('shuffle')} Shuffle</button>
      <button class="btn btn-ghost" data-action="queue-album" data-album-id="${esc(album.id)}" data-source="${esc(album.source)}">${icon('queue')} Queue</button>
      <button class="btn btn-ghost" data-action="album-menu" data-album-id="${esc(album.id)}" data-source="${esc(album.source)}">${icon('more')}</button>`,
    extra: `<div class="detail-sub">
      <span>${tracks.length} track${tracks.length === 1 ? '' : 's'}</span>
      <span class="dot"></span>
      <span>${fmtLong(duration) || '—'}</span>
      <span class="spacer"></span>
      ${artistId ? `<button class="ghost-btn" data-action="open-artist" data-artist-id="${esc(artistId)}" data-source="${esc(album.source)}">${icon('mic')} ${esc(album.artist || 'Artist')}</button>` : `<span>${esc(album.artist || '')}</span>`}
    </div>`,
  })}
  ${trackList(state, tracks, `album:${album.id}`, { noCover: true, hideAlbum: true, emptyTitle: 'No tracks', emptyText: 'This album has no playable songs.' })}`;
}

export function artist(state, artist) {
  const albums = artist.albums || [];
  const songs = artist.songs || [];
  const art = artist.coverUrl || albums[0]?.coverUrl || '';
  const head = `${detailHead({
    eyebrow: 'Artist',
    title: artist.name,
    artClass: 'is-artist',
    art: art ? `<div class="cover artist-round"><img src="${esc(art)}" alt="" /></div>` : `<div class="cover-fallback cover"><span class="cover-glyph">${icon('mic')}</span></div>`,
    meta: `<strong>${albums.length}</strong> album${albums.length === 1 ? '' : 's'}${artist.albumCount && artist.albumCount !== albums.length ? ` <span class="dot"></span> ${artist.albumCount} total` : ''}`,
    actions: songs.length ? `${playBtn('Play top songs', 'play-artist', `data-artist-id="${esc(artist.id)}"`)}` : '',
    extra: `<div class="detail-sub">${artist.biography ? esc(artist.biography).slice(0, 260) : 'Albums from this artist in your library'}</div>`,
  })}`;
  const top = songs.length ? `${sectionHead('Top songs')}${trackList(state, songs, `artist:${artist.id}`, { flush: true, noCover: false })}` : '';
  const discography = albums.length ? `${sectionHead('Discography', `${albums.length} album${albums.length === 1 ? '' : 's'}`)}<div class="album-grid">${[...albums].sort((a, b) => (a.year || 0) - (b.year || 0)).map((a) => albumCard(state, a)).join('')}</div>` : '';
  return head + top + discography;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export function search(state, results, query) {
  if (!query.trim()) {
    return `<div class="search-note">
      <div class="big-icon">${icon('search')}</div>
      <h3>Search your library</h3>
      <p>Songs, albums and artists — start typing in the search box above.</p>
    </div>`;
  }
  if (!results) {
    return `<div class="search-note">
      <div class="big-icon">${icon('search')}</div>
      <h3>Searching…</h3>
      <p>Looking for “${esc(query)}”.</p>
    </div>`;
  }
  const songs = results.songs || [];
  const albums = results.albums || [];
  const artists = results.artists || [];
  const top = results.top;
  const empty = !songs.length && !albums.length && !artists.length;

  if (empty) {
    return `<div class="search-note">
      <div class="big-icon">${icon('search')}</div>
      <h3>No results for “${esc(query)}”</h3>
      <p>Try a different spelling, or search by album or artist name.</p>
    </div>`;
  }

  const topHTML = top ? `<div class="search-top">
    <div>
      <div class="eyebrow" style="margin:6px 0 10px">Top result</div>
      <div class="top-result" data-action="${top.type === 'artist' ? 'open-artist' : top.type === 'album' ? 'open-album' : 'play-search-top'}" ${top.type === 'artist' ? `data-artist-id="${esc(top.item.id)}"` : top.type === 'album' ? `data-album-id="${esc(top.item.id)}" data-source="${esc(top.item.source)}"` : `data-track-id="${esc(top.item.id)}"`}>
        <div class="tr-art">${coverHTML(top.item)}</div>
        <div>
          <div class="type">${esc(top.type)}</div>
          <h3>${esc(top.item.name || top.item.title)}</h3>
          <div class="sub">${esc(top.item.artist || top.item.albumArtist || (top.type === 'artist' ? `${top.item.albumCount || 0} albums` : 'Song'))}</div>
        </div>
      </div>
    </div>
    <div>
      <div class="eyebrow" style="margin:6px 0 10px">Songs</div>
      ${songs.length
        ? trackList(state, songs.slice(0, 5), 'search:top-songs', { flush: true })
        : `<div class="muted" style="padding:18px 6px;font-size:12px">No matching songs.</div>`}
    </div>
  </div>` : '';

  const songsSection = songs.length
    ? `${sectionHead(`Songs`, `${songs.length} result${songs.length === 1 ? '' : 's'}`)}
       ${trackList(state, songs, 'search:songs', { flush: true })}`
    : '';

  const albumSection = albums.length
    ? `${sectionHead('Albums', `${albums.length} result${albums.length === 1 ? '' : 's'}`)}
       <div class="album-grid">${albums.map((a) => albumCard(state, a)).join('')}</div>`
    : '';

  const artistSection = artists.length
    ? `${sectionHead('Artists', `${artists.length} result${artists.length === 1 ? '' : 's'}`)}
       <div class="artist-grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">${artists.map((a) => artistCard(a)).join('')}</div>`
    : '';

  const totalResults = songs.length + albums.length + artists.length;
  return `<div class="page-head">
      <div class="eyebrow">Results for</div>
      <h1>“${esc(query)}”</h1>
      <div class="sub">${totalResults} ${totalResults === 1 ? 'match' : 'matches'} in ${state.source === 'server' ? 'your server' : 'your library'}</div>
    </div>
    ${topHTML}${songsSection}${albumSection}${artistSection}`;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const ACCENTS = [
  { key: 'auto', css: 'conic-gradient(#8b5cf6,#22d3ee,#34d399,#fbbf24,#f472b6,#8b5cf6)', title: 'Auto — matches the music' },
  { key: '262', css: '#8b5cf6' },
  { key: '212', css: '#38bdf8' },
  { key: '160', css: '#34d399' },
  { key: '42', css: '#fbbf24' },
  { key: '332', css: '#f472b6' },
  { key: '0', css: '#f87171' },
  { key: '278', css: '#c084fc' },
  { key: '24', css: '#fb923c' },
];

const SORTS = { name: 'Name', artist: 'Artist', year: 'Year', recent: 'Recently added' };
const MODES = { grid: 'grid', list: 'rows' };

export function sortLabel(mode) {
  return SORTS[mode] || 'Name';
}

export function settings(state) {
  const s = state.settings;
  const sub = s.subsonic || {};
  const folderChips = (s.libraryFolders || []).map((f) => `<div class="folder-chip">${icon('folder')}<span title="${esc(f)}">${esc(f)}</span><button data-action="remove-folder" data-folder="${esc(f)}" title="Remove folder">${icon('x')}</button></div>`).join('');
  const server = state.serverStatus;
  const serverBadge = server
    ? `<span class="server-badge ${server.ok ? 'ok' : 'err'}"><span class="dot" style="width:6px;height:6px;border-radius:50%;background:currentColor"></span>${server.ok ? `Connected · ${server.latency} ms` : esc(server.error || 'Not connected')}</span>`
    : '';

  return `<div class="page-head">
      <div class="eyebrow">Preferences</div>
      <h1>Settings</h1>
      <div class="sub">Make Aurora feel like yours.</div>
    </div>
    <div class="settings-wrap">

      <div class="settings-section">
        <h2>Appearance</h2>
        <div class="settings-card">
          <div class="setting-row">
            <div class="sr-main">
              <div class="sr-title">Theme</div>
              <div class="sr-desc">Three hand-tuned moods for the interface.</div>
            </div>
            <div class="theme-pills">
              ${['midnight', 'slate', 'rose'].map((t) => `<button class="theme-pill ${s.theme === t ? 'active' : ''}" data-action="set-theme" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
            </div>
          </div>
          <div class="setting-row">
            <div class="sr-main">
              <div class="sr-title">Accent</div>
              <div class="sr-desc">“Auto” lets every album tint the interface with its own colour.</div>
            </div>
            <div class="swatches">
              ${ACCENTS.map((a) => `<button class="swatch ${a.key === 'auto' ? 'auto' : ''} ${String(s.accent) === a.key ? 'active' : ''}" style="${a.key === 'auto' ? '' : `background:${a.css}`}" data-action="set-accent" data-accent="${a.key}" title="${esc(a.title || a.css)}"></button>`).join('')}
            </div>
          </div>
          <div class="setting-row">
            <div class="sr-main">
              <div class="sr-title">Ambient glow</div>
              <div class="sr-desc">How strongly the background reacts to your music.</div>
            </div>
            <input class="range" type="range" min="0" max="1" step="0.05" value="${s.backgroundIntensity ?? 0.55}" data-setting-range="backgroundIntensity" />
          </div>
          <div class="setting-row">
            <div class="sr-main">
              <div class="sr-title">Reduce motion</div>
              <div class="sr-desc">Calm animations and background movement.</div>
            </div>
            <button class="server-badge ${s.reduceMotion ? 'ok' : ''}" data-action="toggle-motion">${s.reduceMotion ? 'On' : 'Off'}</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>Music library</h2>
        <div class="settings-card">
          <div class="setting-row">
            <div class="sr-main">
              <div class="sr-title">Folders</div>
              <div class="sr-desc">${state.tracks.length} tracks scanned${state.libraryScannedAt ? ` · last scan ${new Date(state.libraryScannedAt).toLocaleString()}` : ''}</div>
              ${folderChips || '<div class="sr-desc" style="margin-top:8px">No folders added yet.</div>'}
            </div>
            <div class="sr-action" style="flex-direction:column;align-items:stretch;gap:6px">
              <button class="btn btn-soft btn-sm" data-action="add-folder">${icon('plus')} Add folder</button>
              <button class="btn btn-primary btn-sm" data-action="scan-library" ${state.scanning ? 'disabled' : ''}>${icon('refresh')} ${state.scanning ? 'Scanning…' : 'Rescan'}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="sr-main">
              <div class="sr-title">Lyrics</div>
              <div class="sr-desc">Aurora reads <strong>.lrc</strong> files next to your tracks, embedded lyrics, and OpenSubsonic lyrics from your server.</div>
            </div>
            <span class="server-badge ok">Ready</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>Music server</h2>
        <div class="settings-card">
          <div class="setting-row" style="align-items:flex-start">
            <div class="sr-main">
              <div class="sr-title">Subsonic-compatible server</div>
              <div class="sr-desc">Navidrome, Subsonic, Airsonic, Gonic, Ampache and others. Use the server address including http:// or https://.</div>
            </div>
            ${serverBadge}
          </div>
          <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:6px">
            <div class="field">
              <label for="srv-url">Server URL</label>
              <input class="input" id="srv-url" data-setting="subsonic.url" placeholder="http://localhost:4533" value="${esc(sub.url || '')}" spellcheck="false" />
            </div>
            <div class="input-row">
              <div class="field">
                <label for="srv-user">Username</label>
                <input class="input" id="srv-user" data-setting="subsonic.username" placeholder="username" value="${esc(sub.username || '')}" spellcheck="false" />
              </div>
              <div class="field">
                <label for="srv-pass">Password</label>
                <input class="input" id="srv-pass" type="password" data-setting="subsonic.password" placeholder="•••••••" value="${esc(sub.password || '')}" />
              </div>
            </div>
            <div class="row" style="justify-content:flex-end;margin-top:4px">
              <button class="btn btn-soft btn-sm" data-action="test-server">${icon('wifiOff')} Test connection</button>
              <button class="btn btn-primary btn-sm" data-action="save-server">${icon('check')} Save & connect</button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>Keyboard</h2>
        <div class="settings-card">
          ${[
            ['Space', 'Play / pause'],
            ['← / →', 'Seek 5 seconds'],
            ['Shift + ← / →', 'Previous / next track'],
            ['S', 'Toggle shuffle'],
            ['R', 'Cycle repeat'],
            ['F', 'Favorite current track'],
            ['L', 'Open lyrics'],
            ['Q', 'Toggle queue'],
            ['Ctrl / ⌘ + K', 'Search'],
            ['0 – 9', 'Jump through the track'],
          ].map(([k, d]) => `<div class="setting-row" style="min-height:44px;padding:10px 18px"><div class="sr-main"><div class="sr-title" style="font-size:12.5px">${d}</div></div><kbd class="server-badge">${k}</kbd></div>`).join('')}
        </div>
      </div>

      <div class="settings-section">
        <h2>About</h2>
        <div class="settings-card about-card">
          <div class="about-logo">
            <svg viewBox="0 0 32 32" fill="none">
              <defs><linearGradient id="about-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
              <circle cx="16" cy="16" r="13" stroke="url(#about-grad)" stroke-width="2"/><circle cx="16" cy="16" r="3.4" fill="url(#about-grad)"/>
              <path d="M16 3a13 13 0 0 1 13 13" stroke="#fff" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="grow">
            <div class="sr-title" style="font-size:15px">Aurora ${esc(state.appInfo?.version || '1.0.0')}</div>
            <div class="sr-desc">A Feishin-inspired desktop music player. Built with Electron, vanilla JS and a lot of care for lyrics.</div>
          </div>
          <button class="btn btn-ghost btn-sm" data-action="open-data-folder">Data folder</button>
        </div>
      </div>
    </div>`;
}
