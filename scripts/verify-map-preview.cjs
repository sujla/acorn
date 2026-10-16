const { app, BrowserWindow } = require('electron');
const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-map-ui-'));
    const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import Map,{Marker,Polyline} from './src/main/expo-preview/native-map.js';
      const ref=React.createRef(); window.map=ref; window.changes=[];
      createRoot(document.getElementById('root')).render(<Map ref={ref} style={{width:390,height:600}} initialCamera={{center:{latitude:1.3,longitude:103.8},zoom:14}} onRegionChangeComplete={r=>window.changes.push(r)}>
      <Marker identifier="test" coordinate={{latitude:1.3,longitude:103.8}} onPress={()=>window.pressed=true}><span>Custom stop</span></Marker>
      <Polyline coordinates={[{latitude:1.299,longitude:103.799},{latitude:1.301,longitude:103.801}]} /></Map>);`;
    await esbuild.build({ stdin: { contents: entry, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' }, bundle: true, outfile: path.join(directory,'bundle.js'), loader: { '.js': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' } });
    await fs.writeFile(path.join(directory,'index.html'), '<div id="root"></div><script src="bundle.js"></script>');
    const win = new BrowserWindow({ show:false, width:420,height:650, webPreferences:{contextIsolation:true,nodeIntegration:false} });
    await win.loadFile(path.join(directory,'index.html'));
    const run = code => win.webContents.executeJavaScript(code);
    for(let n=0;n<100;n++){ if(await run('!!window.map?.current')) break; await new Promise(r=>setTimeout(r,50)); }
    assert.equal(await run('document.querySelectorAll("[data-acorn-marker]").length'),1);
    assert.equal(await run('document.querySelector("polyline").getAttribute("points").split(" ").length'),2);
    await run('document.querySelector("[data-acorn-marker]").click()');
    assert.equal(await run('window.pressed'),true);
    await run('window.map.current.animateCamera({center:{latitude:1.31,longitude:103.81},zoom:15})');
    assert.equal(await run('(async()=> (await window.map.current.getCamera()).zoom)()'),15);
    assert.ok(await run('window.changes.length>0'));
    await run('window.map.current.fitToElements({edgePadding:{top:20,bottom:20,left:20,right:20}})');
    assert.equal(await run('(async()=>Math.abs((await window.map.current.getCamera()).center.latitude-1.3)<1e-8)()'),true);
    await run(`document.querySelector('[data-acorn-map]').dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}))`);
    assert.equal(await run('(async()=> (await window.map.current.getCamera()).zoom)()'),20.5);
    console.log('Map UI passed: custom marker, polyline, click, camera and fit.');
  } catch(error) { console.error(error); process.exitCode=1; }
  finally { if(directory) await fs.rm(directory,{recursive:true,force:true}); app.exit(process.exitCode||0); }
});
