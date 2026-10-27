// Run through shot.mjs --eval against a viewer with mocked update endpoints: a newer
// installer is available; POST accepts it; subsequent GET reports a checksum failure.
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await new Promise((r) => setTimeout(r, 1800));
  const box = document.querySelector("#update");
  const install = document.querySelector("#update-install");
  assert(!box.hidden && !install.hidden, "installer offer is visible");
  const version = box.dataset.version;
  install.click();
  assert(install.disabled, "install cannot be submitted twice");
  for (let i = 0; i < 50 && !box.classList.contains("failed"); i++) await new Promise((r) => setTimeout(r, 100));
  assert(box.classList.contains("failed") && box.textContent.includes("checksum"), "failure is reported");
  assert(!install.disabled, "failed install can be retried");
  document.querySelector("#update-dismiss").click();
  assert(box.hidden && localStorage.getItem("cadkit.update.dismissed") === version, "dismissal remembers the version even after an error");
  localStorage.removeItem("cadkit.update.dismissed");
  return { passed: 4, version };
})()
