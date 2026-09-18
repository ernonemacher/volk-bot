# Brand assets

Uploaded to the Discord developer portal by hand. Nothing in the *bot* reads
them at runtime; the Mac control panel serves two of them over loopback.

| File | Where it is used |
|---|---|
| `icon-app-1024.png` | Application icon and bot avatar; the crest and favicon on the control panel |
| `banner-1360x480.png` | Bot profile banner, cropped to Discord's 17:6; the control panel's header |
| `banner-1360.png` | The uncropped original the banner came from |
| `emoji-*.svg` | Source for the application emoji |

## The palette

The control panel's colours are **sampled from these files**, not chosen to go
with them, so the page and the bot's Discord profile read as one thing:

| Token | Value | Where it comes from |
|---|---|---|
| carmine | `#a31d30` | the faceted wolf in the banner |
| ink | `#dfd9cd` | the warm off-white it is outlined in, never pure white |
| void / panel | `#0d0d0d` / `#191919` | the banner's own near-black ground |

Resample rather than guess if the art is ever redrawn:

```bash
node -e "const sharp=require('sharp');(async()=>{const{data,info}=await sharp('assets/banner-1360x480.png').raw().toBuffer({resolveWithObject:true});const c=new Map();for(let i=0;i<data.length;i+=info.channels){const[r,g,b]=[data[i],data[i+1],data[i+2]];if(Math.max(r,g,b)-Math.min(r,g,b)>60&&Math.max(r,g,b)>90){const k=[r,g,b].join(',');c.set(k,(c.get(k)||0)+1)}}console.log([...c].sort((a,b)=>b[1]-a[1]).slice(0,3))})()"
```

The panel is dark-only on purpose: the assets are drawn on black, and a light
theme would have to fight them rather than carry them.

The emoji PNGs are build output, not source. Regenerate them with:

```bash
node tools/render-emojis.mjs
```

That needs Playwright, which is a devDependency and is deliberately absent from
a production install. Run it locally, never on the server.
