// Run with scripts/shot.mjs --eval (after the normal drawing has loaded).
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const originalFetch = window.fetch;
  const file = cadkit.state().file;
  const statuses = [];
  let delay = false;
  window.fetch = async (...args) => {
    if (String(args[0]).startsWith('/api/drawing')) {
      if (delay) await wait(1500);
      const res = await originalFetch(...args);
      statuses.push(res.status);
      return res;
    }
    return originalFetch(...args);
  };
  try {
    await cadkit.open(file);
    assert(statuses.at(-1) === 304, 'repeat open must revalidate and reuse the browser payload');
    delay = true;
    const opening = cadkit.open(file);
    await wait(1150);
    const overlay = document.querySelector('#overlay');
    assert(!overlay.classList.contains('hidden') && /1s elapsed/.test(overlay.textContent), 'slow opens must show live elapsed feedback');
    await opening;
    assert(overlay.classList.contains('hidden'), 'successful open must dismiss loading feedback');
    assert(/Opened in/.test(document.querySelector('#load-time').textContent), 'completed load must retain its timing');
    delay = false;
    document.querySelector('[data-tab="files"]').click();
    assert(!document.querySelector('#path-form, #computer-button, input#path'), 'folder navigation must not require typing paths');
    let picked = '/chosen-drawings';
    let pickerCalls = 0;
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (url.startsWith('/api/pick-folder')) {
        pickerCalls++;
        assert(args[1].method === 'POST', 'folder picker must use POST');
        return new Response(JSON.stringify({ folder: picked }));
      }
      if (url.startsWith('/api/files?')) {
        const dir = new URL(url, location.href).searchParams.get('dir');
        return new Response(JSON.stringify({ dir, parent: dir === '/chosen-drawings/Sheets' ? '/chosen-drawings' : '/', entries: dir === '/chosen-drawings' ? [{ name: 'Sheets', path: '/chosen-drawings/Sheets', dir: true }] : [] }));
      }
      return originalFetch(...args);
    };
    document.querySelector('#browse-button').click();
    await wait(100);
    assert(pickerCalls === 1 && document.querySelector('#path').textContent === 'chosen-drawings', 'Browse must select a folder without opening a drawing');
    document.querySelector('#dir li[data-d]').click();
    await wait(100);
    assert(document.querySelector('#path').textContent === 'Sheets', 'clicking a folder must navigate into it');
    document.querySelector('#folder-back').click();
    await wait(100);
    assert(document.querySelector('#path').textContent === 'chosen-drawings', 'curved back button must return to the parent');
    assert(!document.querySelector('#dir li[title^="Up to"]'), 'parent navigation must not appear as an ambiguous dot row');
    picked = null;
    document.querySelector('#browse-button').click();
    await wait(100);
    assert(document.querySelector('#path').textContent === 'chosen-drawings' && !document.querySelector('#browse-button').disabled, 'cancelling the picker must keep the folder and restore Browse');
    for (const side of ['left', 'right']) {
      const close = document.querySelector(`[data-collapse="${side}"]`);
      assert(close.querySelector('use').getAttribute('href') === '#i-close', 'panel close controls must use crosses');
      close.click();
      assert(document.body.classList.contains(`${side}-hidden`), 'cross must collapse its panel');
      document.querySelector(`#ribbon-${side} button`).click();
    }
    // Exercise Windows path handling on any browser host, keeping the real drawing
    // and lint requests. Only the drawing's reported source path is substituted.
    let windowsSource = 'E:\\Survey\\Road.dwg';
    let browsed = '';
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (url.startsWith('/api/drawing')) {
        const response = await originalFetch(url);
        const payload = await response.json();
        payload.source.path = windowsSource;
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json', ETag: '"windows-path-check"' } });
      }
      if (url.startsWith('/api/files?')) {
        browsed = new URL(url, location.href).searchParams.get('dir');
        return new Response(JSON.stringify({ dir: browsed, parent: browsed, entries: [] }));
      }
      return originalFetch(...args);
    };
    await cadkit.open(file);
    await wait(100);
    assert(browsed === 'E:/Survey', 'Windows drawing folders must retain the full parent path');
    assert(document.querySelector('#doc-name').textContent === 'Road', 'Windows titles must show just the filename');
    windowsSource = 'E:\\Road.dwg';
    await cadkit.open(file);
    await wait(100);
    assert(browsed === 'E:/', 'a drawing at a drive root must retain the root slash');
    window.fetch = originalFetch;
    await cadkit.open(file);
    document.querySelector('[data-tab="files"]').click();
    return { statuses, feedback: 'elapsed and completion timing checked', folders: 'folder selection, cancel, parent navigation, panel crosses and Windows paths checked' };
  } finally { window.fetch = originalFetch; }
})()
