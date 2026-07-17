"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readPngDimensions(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<24||buffer.toString("ascii",1,4)!=="PNG"){
    throw new Error("UI capture did not produce a valid PNG.");
  }
  return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
}

function captureFileStamp(date=new Date()){
  const pad=value=>String(value).padStart(2,"0");
  return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createUiCaptureController({ app, dialog, shell, appRoot, logEvent, text }){
  const inProgress = new Set();

  async function readGeometry(contents){
    return contents.executeJavaScript(`(()=>{
      const viewport={width:window.innerWidth,height:window.innerHeight};
      const normalize=(rect,padding=0)=>{
        if(!rect||rect.width<=0||rect.height<=0)return null;
        const x=Math.max(0,Math.floor(rect.left-padding));
        const y=Math.max(0,Math.floor(rect.top-padding));
        const right=Math.min(viewport.width,Math.ceil(rect.right+padding));
        const bottom=Math.min(viewport.height,Math.ceil(rect.bottom+padding));
        if(right<=x||bottom<=y)return null;
        return {x,y,width:right-x,height:bottom-y};
      };
      const appRoot=document.querySelector(".app");
      const preview=document.getElementById("previewShell");
      const edit=document.getElementById("editOverlay");
      let callout=null;
      try{
        const frame=document.getElementById("renderPreview");
        const frameRect=frame?.getBoundingClientRect();
        const frameWindow=frame?.contentWindow;
        const element=frameWindow?.document.getElementById("videoCallout");
        const style=element?frameWindow.getComputedStyle(element):null;
        if(frameRect&&element&&style&&Number.parseFloat(style.opacity)>.01){
          const inner=element.getBoundingClientRect();
          const scaleX=frameRect.width/Math.max(1,frameWindow.innerWidth);
          const scaleY=frameRect.height/Math.max(1,frameWindow.innerHeight);
          callout=normalize({
            left:frameRect.left+inner.left*scaleX,
            top:frameRect.top+inner.top*scaleY,
            right:frameRect.left+inner.right*scaleX,
            bottom:frameRect.top+inner.bottom*scaleY,
            width:inner.width*scaleX,
            height:inner.height*scaleY,
          },18);
        }
      }catch{}
      return {
        viewport,
        scopes:{
          full:normalize(appRoot?.getBoundingClientRect()),
          preview:normalize(preview?.getBoundingClientRect()),
          edit:edit&&!edit.classList.contains("closed")?normalize(edit.getBoundingClientRect()):null,
          callout,
        },
      };
    })()`,true);
  }

  async function captureSnapshots2x(contents){
    const initial=await readGeometry(contents);
    const viewport=initial?.viewport;
    if(!viewport||viewport.width<1||viewport.height<1)throw new Error("UI capture viewport is unavailable.");
    const captureDebugger=contents.debugger;
    const attachedByCapture=!captureDebugger.isAttached();
    if(attachedByCapture)captureDebugger.attach("1.3");
    try{
      await captureDebugger.sendCommand("Emulation.setDeviceMetricsOverride",{
        width:viewport.width,
        height:viewport.height,
        deviceScaleFactor:2,
        mobile:false,
        screenWidth:viewport.width,
        screenHeight:viewport.height,
      });
      await contents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",true);
      const geometry=await readGeometry(contents);
      const snapshots={};
      for(const [scope,rect] of Object.entries(geometry.scopes||{})){
        if(!rect)continue;
        try{
          const result=await captureDebugger.sendCommand("Page.captureScreenshot",{
            format:"png",
            fromSurface:true,
            captureBeyondViewport:false,
            clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1},
          });
          const png=Buffer.from(result.data||"","base64");
          const size=readPngDimensions(png);
          const expectedWidth=rect.width*2;
          const expectedHeight=rect.height*2;
          if(Math.abs(size.width-expectedWidth)>3||Math.abs(size.height-expectedHeight)>3){
            throw new Error(`DPR 2 verification failed for ${scope}: ${size.width}x${size.height}, expected ${expectedWidth}x${expectedHeight}.`);
          }
          snapshots[scope]={png,...size};
        }catch(error){
          snapshots[scope]={error:error.message};
        }
      }
      return snapshots;
    }finally{
      try{await captureDebugger.sendCommand("Emulation.clearDeviceMetricsOverride")}catch{}
      if(attachedByCapture&&captureDebugger.isAttached())captureDebugger.detach();
    }
  }

  async function showError(owner,key="ui_capture_failed"){
    await dialog.showMessageBox(owner,{
      type:"error",
      title:"Capture UI 2X",
      message:text(key),
      buttons:["CLOSE"],
      defaultId:0,
      cancelId:0,
      noLink:true,
    });
  }

  async function open(owner){
    if(!owner||owner.isDestroyed())return;
    const ownerId=owner.webContents.id;
    if(inProgress.has(ownerId))return;
    inProgress.add(ownerId);
    try{
      // Capture before opening the chooser so a playing preview keeps the hotkey-time frame.
      const snapshots=await captureSnapshots2x(owner.webContents);
      const scopes=["full","preview","edit","callout"];
      const choice=await dialog.showMessageBox(owner,{
        type:"question",
        title:"Capture UI 2X",
        message:text("ui_capture_choose"),
        detail:text("ui_capture_detail"),
        buttons:["FULL APP","PREVIEW AREA","EDIT PANEL","TITLE CALLOUT","CANCEL"],
        defaultId:1,
        cancelId:4,
        noLink:true,
      });
      if(choice.response===4){
        logEvent("ui_capture_cancelled",{phase:"scope"});
        return;
      }
      const scope=scopes[choice.response];
      const snapshot=snapshots[scope];
      if(!snapshot){
        logEvent("ui_capture_failed",{scope,code:"SCOPE_UNAVAILABLE",message:"Scope is not visible."});
        await showError(owner,"ui_capture_scope_unavailable");
        return;
      }
      if(snapshot.error){
        logEvent("ui_capture_failed",{scope,code:"CAPTURE_FAILED",message:snapshot.error});
        await showError(owner);
        return;
      }
      const slug={full:"full-app",preview:"preview-area",edit:"edit-panel",callout:"title-callout"}[scope];
      let defaultFolder="";
      try{defaultFolder=app.getPath("pictures")}catch{}
      const save=await dialog.showSaveDialog(owner,{
        title:"Save 2X PNG",
        defaultPath:path.join(defaultFolder||appRoot,`workflow-showcase-${slug}-2x-${captureFileStamp()}.png`),
        buttonLabel:"SAVE PNG",
        filters:[{name:"PNG Image",extensions:["png"]}],
        properties:["showOverwriteConfirmation"],
      });
      if(save.canceled||!save.filePath){
        logEvent("ui_capture_cancelled",{phase:"save",scope});
        return;
      }
      const outputPath=save.filePath.toLowerCase().endsWith(".png")?save.filePath:save.filePath+".png";
      fs.writeFileSync(outputPath,snapshot.png);
      logEvent("ui_capture_completed",{scope,width:snapshot.width,height:snapshot.height});
      shell.showItemInFolder(outputPath);
    }catch(error){
      logEvent("ui_capture_failed",{code:error.code||"CAPTURE_FAILED",message:error.message});
      await showError(owner);
    }finally{
      inProgress.delete(ownerId);
    }
  }

  function registerShortcut(window){
    window.webContents.on("before-input-event",(event,input)=>{
      const command=process.platform==="darwin"?input.meta:input.control;
      if(input.type!=="keyDown"||input.isAutoRepeat||!command||!input.shift||String(input.key).toLowerCase()!=="p")return;
      event.preventDefault();
      void open(window);
    });
  }

  return { open, registerShortcut };
}

module.exports = { createUiCaptureController, readPngDimensions, captureFileStamp };
