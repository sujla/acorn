// Preview processes use their own group so stopping npm also stops its dev server.
async function stopRuntimeProcess(child) {
  if (!child?.pid) return;
  const group = process.platform !== 'win32';
  const signal = (name) => {
    try {
      if (group) process.kill(-child.pid, name);
      else child.kill(name);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (group) {
      try { process.kill(-child.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
    } else if (child.exitCode !== null || child.signalCode !== null) return;
  }
  signal('SIGKILL');
}
module.exports = { stopRuntimeProcess };
