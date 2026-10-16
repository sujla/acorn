// Keep this entry point at the project root when reorganizing source folders.
const { app, BrowserWindow, dialog } = require('electron');
const { startApplication } = require('./desktop-lifecycle.cjs');

startApplication({ app, BrowserWindow, dialog, load: file => require(file) });
