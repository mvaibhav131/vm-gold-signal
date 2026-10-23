(function () {
  // Runs before the first paint so the saved theme (dark by default) never flashes.
  // Same key as Mantine's own colour scheme storage; an external file keeps a strict CSP possible.
  var scheme = 'dark';
  try {
    if (window.localStorage.getItem('mantine-color-scheme-value') === 'light') scheme = 'light';
  } catch (error) {
    scheme = 'dark';
  }
  document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
})();
