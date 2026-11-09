// Automatic updates from GitHub Releases (electron-updater). Active only in
// packaged builds published with update metadata; silent unless an update has
// downloaded or the user asked to check.

const { app, dialog } = require('electron');

let updater = null;

function setupUpdates(parentWindow) {
  // MSIX installs are read-only and updated by Windows (the Store or the installer).
  if (!app.isPackaged || process.windowsStore || process.env.AGILITY_TEST_DIR || process.env.AGILITY_NO_UPDATE) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch {
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('error', () => {}); // offline, or no release published yet
  updater.on('update-downloaded', (info) => {
    const choice = dialog.showMessageBoxSync(parentWindow(), {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Agility ${info.version} is ready to install.`,
      detail: 'Restart to finish updating, or it will install the next time you quit.',
    });
    if (choice === 0) updater.quitAndInstall();
  });
  updater.checkForUpdates().catch(() => {});
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 3600e3).unref();
}

async function checkForUpdatesNow(win) {
  if (!updater) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: `Agility ${app.getVersion()}`,
      detail: process.windowsStore ? 'Windows keeps this copy up to date.'
        : app.isPackaged ? 'Automatic updates are not set up for this build.' : 'Updates are checked in installed releases only.',
    });
    return;
  }
  try {
    const result = await updater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!latest || latest === app.getVersion()) {
      dialog.showMessageBox(win, { type: 'info', message: "You're up to date.", detail: `Agility ${app.getVersion()} is the latest version.` });
    } else {
      dialog.showMessageBox(win, { type: 'info', message: `Downloading Agility ${latest}…`, detail: "You'll be asked to restart when it's ready." });
    }
  } catch (err) {
    dialog.showMessageBox(win, { type: 'warning', message: "Couldn't check for updates.", detail: err.message });
  }
}

module.exports = { setupUpdates, checkForUpdatesNow };
