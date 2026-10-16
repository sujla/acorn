const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const git = require('isomorphic-git');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-data-ui-'));
const profile = path.join(scratch, 'profile'); fs.mkdirSync(profile);
app.setPath('userData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let reads = 0;
const dataModule = require('../src/main/preview-data.cjs');
const factory = dataModule.createPreviewData;
dataModule.createPreviewData = () => factory({ read: async () => ({ body: JSON.stringify({ value: ++reads }), status: 200 }) });
(async () => {
  const repository = path.join(scratch, 'repo'); await fsp.mkdir(repository);
  await git.init({ fs, dir: repository, defaultBranch: 'main' });
  await fsp.writeFile(path.join(repository, 'index.html'), '<h1 id="result">Waiting</h1><script>fetch("https://data.example.test/read.json").then(r=>r.json()).then(d=>document.getElementById("result").textContent="Data "+d.value).catch(()=>document.getElementById("result").textContent="Permission needed")</script>');
  await git.add({ fs, dir: repository, filepath: 'index.html' });
  await git.commit({ fs, dir: repository, author: {name:'Test',email:'test@example.test'}, message:'fixture' });
  await fsp.writeFile(path.join(profile, 'repositories.json'), JSON.stringify([repository]));
  require('../src/main/desktop-main.cjs'); await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0]; window.hide();
  while (window.webContents.isLoading()) await sleep(50);
  const run = code => window.webContents.executeJavaScript(code);
  const waitFor = async code => { for (let i=0;i<200;i++) { if (await run(code)) return; await sleep(50); } throw new Error('Timed out: '+code); };
  try {
    await run(`(async()=>{ repositories=await window.acornGit.listRepositories(); activateRepository(${JSON.stringify(repository)}); })()`);
    await waitFor(`previewState.base === 'ready' && previewState.target === 'ready'`);
    await waitFor(`window.acornGit.previewDataStatus({path:${JSON.stringify(repository)}}).then(s=>s.sources.length===1)`);
    assert.equal(reads, 1, 'Public data loads automatically and is shared');
    for (const name of ['base-preview','target-preview']) {
      const frame = window.webContents.mainFrame.frames.find(frame=>frame.name===name);
      assert.equal(await frame.executeJavaScript('document.getElementById("result").textContent'), 'Data 1');
    }
    await run(`window.acornGit.refreshPreviewData({path:${JSON.stringify(repository)}}).then(() => schedulePreview())`);
    for (let attempt=0;attempt<100;attempt++) { if (reads===2) break; await sleep(50); }
    assert.equal(reads, 2);
    console.log(JSON.stringify({passed:true,checks:['automatic public data','shared Base/Target response','explicit refresh']}));
  } catch(error) { console.error(error); process.exitCode=1; }
  finally { app.quit(); }
})().catch(error=>{console.error(error);app.exit(1)});
