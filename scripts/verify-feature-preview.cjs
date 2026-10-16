const { app, BrowserWindow } = require('electron');
const esbuild = require('esbuild');
const babel = require('@babel/core');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-feature-ui-'));
    const source = `import React,{useState,useEffect} from 'react'; import {createRoot} from 'react-dom/client';
      import {CameraView} from 'expo-camera'; import {WebView} from 'react-native-webview';
      function Broken(){throw new Error('Native view unavailable')}
      function EffectFailure(){useEffect(()=>{throw new Error('Native effect unavailable')},[]);return <div>effect</div>}
      function Good(){const [n,set]=useState(0);return <button id="counter" onClick={()=>set(n+1)}>Count {n}</button>}
      function App(){return <main><h1>Other Expo app</h1><Good/><CameraView/><WebView/><Broken/><EffectFailure/><footer>Still visible</footer></main>}
      createRoot(document.getElementById('root')).render(<App/>);`;
    const transformed = babel.transformSync(source, {filename:path.join(directory,'App.jsx'),babelrc:false,configFile:false,parserOpts:{plugins:['jsx']},plugins:[require('../src/main/expo-preview/feature-boundary-plugin.cjs')]}).code;
    await esbuild.build({stdin:{contents:transformed,resolveDir:path.resolve(__dirname,'..'),loader:'jsx'},bundle:true,outfile:path.join(directory,'bundle.js'),loader:{'.js':'jsx'},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'native-adapters',setup(build){build.onResolve({filter:/^(expo-camera|react-native-webview)$/},args=>({path:args.path,namespace:'adapter'}));build.onLoad({filter:/.*/,namespace:'adapter'},args=>({contents:require('../src/main/expo-preview/feature-adapters.cjs').sourceFor(args.path),loader:'js',resolveDir:path.resolve(__dirname,'..')}));}}]});
    await fs.writeFile(path.join(directory,'index.html'),'<div id="root"></div><script>window.uncaught=0;window.addEventListener("error",()=>window.uncaught++);</script><script src="bundle.js"></script>');
    const win = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    await win.loadFile(path.join(directory,'index.html'));
    const run = code=>win.webContents.executeJavaScript(code);
    for(let i=0;i<100;i++){if(await run('document.querySelectorAll("[data-acorn-unavailable]").length===4'))break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(await run('document.querySelectorAll("[data-acorn-unavailable]").length'),4);
    assert.equal(await run('document.querySelector("footer").textContent'),'Still visible');
    await run('document.getElementById("counter").click()');
    assert.equal(await run('document.getElementById("counter").textContent'),'Count 1');
    assert.equal(await run('window.uncaught'),0);
    console.log('Feature preview passed: camera/webview notices, isolated render/effect errors, working sibling UI.');
  } catch(error){console.error(error);process.exitCode=1;}
  finally{if(directory)await fs.rm(directory,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
