"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("motionOrganizer", Object.freeze({ isDesktop: true }));
