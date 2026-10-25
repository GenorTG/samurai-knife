/**
 * How the assistant (and outside agents through knife_ui_call) should work in a Craft app with an agent API: units and
 * coordinates, how to read the document, the commands for common jobs with parameters that were run against the real
 * app at `verified`, and its pitfalls. Returned by craft_guide; `brief` goes into the page snapshot's note.
 *
 * Every command id written as `name.id` here must exist in that app's catalogue (tests/craft_guides.test.mjs checks
 * them against tests/fixtures/craft-commands/<app>-<verified>.json); refresh the fixture and re-run the recipes when a
 * pin moves (docs/SIDECARS.md "The assistant inside an app"). Sources: the apps' own docs (docs/agents.md, docs/mcp.md,
 * docs/web.md of each release) and what the web builds actually return. Pure data, no imports.
 */

export interface CraftGuide {
  app: string;
  /** The app version the recipes were run against. */
  verified: string;
  /** One or two sentences for the page snapshot. */
  brief: string;
  /** The guide itself (plain text with `command` ids). */
  text: string;
}

const COMMON = `How to work: read the state, act in small steps, read the result fields (ids, paths) and use them in the next call, check with a read (or craft_screenshot for a file the user can see), undo with edit.undo if it went wrong. Before a command you have not used yet, read its whole parameter doc with craft_commands {command:"<id>"}; a command that needs a selection says why it is disabled. Paths in parameters (exports, saves) are the app's own in-browser file table, never the user's disk: list it with craft_files and copy a file into your file chain with craft_export {path}.`;

const VECTORCRAFT = `VectorCraft (vector illustration, Illustrator-like).

Units and coordinates: points (pt) unless the document was made in other units; x right, y DOWN, origin at the top-left of the first artboard. file.new defaults to US Letter 612 x 792 pt.

Start: no document may be open (most commands are disabled then). Make one: file.new {name, width, height, units:"Pixels"} -> {index}. craft_inspect shows the app's UI (tool, panels); the DRAWING is read with document.inspect {depth:2} -> artboards, layers -> children [{id, kind, name, bounds:{x,y,width,height}, fill, stroke}], selection, history.

Draw (each returns {id}; the new object becomes the selection and takes the current paint):
- shape.rectangle {x, y, width, height, radius?}; shape.ellipse {x, y, width, height}
- shape.polygon {cx, cy, radius, sides}; shape.star {cx, cy, radius1, radius2, points}; shape.line {x1, y1, x2, y2}
- path.create {d:"M100 400 C 200 300 300 500 400 400", closed:false} or {anchors:[{x, y, in?:[x,y], out?:[x,y]}], closed}
- text.create {x, y, text, size, font?, color:"#ffffff", justify:"center"} -> {id, bounds} (point type: with justify center, x is the centre of the line and y the baseline)
- layer.new {name} -> {id} (new art goes into the current layer)

Style (applies to the selection, or to {ids:[…]}):
- paint.setFill {color:"#1e88e5"} | {none:true} | {gradient:{kind:"linear"|"radial", stops:[{offset:0, color:"#ff0080"}, {offset:1, color:"#7928ca"}], angle:0}}
- paint.setStroke {color} | {none:true}; stroke.set {weight, cap:"round", join, dash:[6,4]}
- object.setProps {ids?, name, opacity:0..100, blend}
- effects: effect.apply {effect:"stylize.dropShadow", ids?} (ids from effect.list; with no ids it applies to EVERY selected object: select first, or pass ids)

Arrange: select.all / select.none; object.align {horizontal:"center", vertical:"center", to:"artboard"} (aligns the selection); object.move {ids?, dx, dy}; object.group {ids} -> {id}; object.transform {ids, matrix:[a,b,c,d,e,f]}; edit.clear {ids?} deletes (the selection by default).

One undo step for several edits: command.batch {label, commands:[{command, params}, …]} -> {results:[…]} (stops at the first error and rolls the whole batch back). Example: [{command:"shape.star", params:{cx:400, cy:500, radius1:60, radius2:25, points:5}}, {command:"paint.setFill", params:{color:"#ffc107"}}].

Export: document.export {format:"png", ppi:144, background:"white"} WITHOUT a path (the web build has no file system and refuses one): the file comes back as data and craft_execute puts it in your file chain (new_files: f3…). Also format "svg", "pdf", "jpg", "webp"; artboard:<index> for one artboard.

Pitfalls: set paint right after drawing (or pass ids), or the next shape inherits it; effect.apply and paint.* act on everything selected; ids in document.inspect are stable, names are not unique.`;

const FILMCRAFT = `FilmCraft (video editor, Premiere-like). It opens with a demo project (bins of clips, item ids in project.inspect).

Time: the engine counts ticks, 254016000000 per second. Most commands also take {seconds} (or frame / timecode), timeline.razor and playhead.set included; where the params list only "time":ticks (markers.add, timeline.move) give ticks: seconds x 254016000000. Tracks are named "V1", "V2", "A1"…

Read: project.inspect -> bins and items [{item, name, type, duration (ticks)}]; sequence.inspect -> the active sequence: video/audio tracks, each with items [{clip, item, start, end, durationFrames, effects}], markers, playhead, selection; state.inspect -> editor state.

Build a sequence:
- file.newSequence {name, width:1920, height:1080, fps:30} -> {sequence}, or {name, fromItem:<item>} to match a clip's settings
- timeline.place {item, track:"V1", seconds:0} -> {clips:[picture, sound]} (insert:true pushes later clips)
- media from the user: craft_import their files (ids from your file chain) -> new items; file.newColorMatte {color:"#2244aa", seconds:2} -> {item}; file.newBarsAndTone {seconds}
- titles: graphics.newText {text, size:100, seconds:<duration>, position:[x,y]} -> {clip} (a title clip starting at the playhead: playhead.set {seconds} first)
- captions: captions.newTrack {format:"Subtitle", name} -> {track}, then captions.add {text, seconds, durationSeconds} -> {caption}

Edit: timeline.razor {seconds, track:"V1"} -> {cuts}; timeline.move {moves:[{clip, track:"V1", time:<ticks>}]}; timeline.trim {clip, edge:"in"|"out", mode:"regular"|"ripple", deltaFrames}; edit.clear {clips:[id]} deletes; playhead.set {seconds}; markers.add {name, time:<ticks>} -> {marker}.

Clip settings (name the clips: a command that works on "the selection" runs on {clips:[id]} with nothing selected): effects.list {kind:"Video"} -> [{id, name, params}]; effects.apply {clips:[id], effect:"Gaussian Blur"}; effects.setParam {clip, effect:"motion", param:"scale", value:120} ("opacity" / effect index for others); clip.speedDuration {clips, speed:200}; clip.audioGain {clips, db:-6}.

Export (paths are the in-browser file table):
- one frame: file.exportFrame {path:"/exports/frame.png"} (at the playhead; time:<ticks> for another)
- video: file.exportMedia {path:"/exports/out.mp4", format:"h264", range:"custom", startSeconds, endSeconds} -> {job}; poll jobs.list until that job has finished:true (etaSeconds = time left; its result gives the bytes written), then craft_files and craft_export {path}. Encoding in the browser is slow (about 90 s for one second of 1080p H.264 without a GPU): export short ranges and tell the user it is running.
Save the project: file.saveAs {path:"/name.fcproj"}.

Pitfalls: timeline.place answers two clips (picture and its linked sound) and timeline.move moves both while Linked Selection is on (it answers {moved:[…]}; {linked:false} moves one); file.newSequence {fromItem} copies that clip's size and frame rate; an export of offline media renders placeholders (media.status).`;

const EFFECTCRAFT = `EffectCraft (motion graphics, After Effects-like).

Time: seconds. Keyframe times are LAYER time (prop.addKey, prop.set with time); prop.get and renders use COMP time. For a layer that starts later or is stretched, pass timeBase:"comp" to give comp seconds.

Read: comp.info {comp?} -> the active comp {id, width, height, duration, frameRate, layers:[{id, name, index, type, in, out, start}]}; prop.get {layer, path, time} -> {value, animated, keys:[{time, value, in, out}]}; editor.state; effect.list {filter:"blur"} -> effects with their params [{id, name, type, default, min, max}].

Build:
- comp.new {name, width:1920, height:1080, frameRate:30, duration:4} -> {comp} (it becomes the active comp)
- layer.newText {text, name:"Title", size, fill:"#ffffff", font?, position?:[x,y]} -> {layer}
- layer.newShape {kind:"rect"|"rounded"|"ellipse"|"star"|"polygon", name, size:[w,h], fill, stroke?, strokeWidth?} -> {layer}
- layer.newSolid {name, color:"#202040", width?, height?} -> {layer}
- footage: craft_import the user's files, then use the new items
NAME every layer when you create it and refer to it by name ({layer:"Title"}); a name that matches no layer is an error.

Animate: prop.addKey {layer, path, time, value}, two or more keys per property. Paths: "transform/position" [x,y], "transform/scale" [%,%], "transform/rotation" (degrees), "transform/opacity" (0-100), "transform/anchorPoint". A static value: prop.set {layer, path, value}. An expression: prop.setExpression {layer, path, expression:"time*90"} (prop.get then reports value and evaluated). Easing: keys.select {keys:[{layer, path, time}]} then keys.velocity {inSpeed:0, inInfluence:75} (or outSpeed/outInfluence). Move a layer in time: layer.timing {layers:["Title"], start:0.5}.

Effects: effect.apply {effect:"Gaussian Blur", layers:["Title"]} -> {effect, paths:["effects/#1"]}; then prop.set {layer:"Title", path:"effects/#1/blurriness", value:8} (param ids from effect.list). Masks: layer.addMask {layer, shape:"ellipse"|"rect"|"rounded", rect:[x,y,w,h]}. Presets: anim.builtinPresets -> anim.applyBuiltinPreset {preset, layers}.

One undo step: engine.batch {label, steps:[{command, params}, …]} -> {results}; "$1.layer" in a later step is step 1's result (atomic: a failing step rolls the batch back). Example: [{command:"layer.newShape", params:{kind:"ellipse", name:"Ring", fill:"#ff5722"}}, {command:"prop.set", params:{layer:"$1.layer", path:"transform/opacity", value:50}}].

Render (paths are the in-browser file table): renderQueue.add {format:"webm"|"gif"|"png"|"h264", output:"/exports/intro.webm"} -> {item}, then renderQueue.render {wait:false} (do NOT wait:true in the browser: the call blocks until the whole render is done) and poll renderQueue.list until that item's status is "Done" (last_output = the file written), then craft_files and craft_export {path}. An image sequence: format "png" with output "/exports/frames/f_[#####].png" (one file per frame); a short range: timeSpan:"custom", start, end (seconds). Save the project: file.saveAs {path:"/intro.ecproj"}.

Pitfalls: effect paths count per layer ("effects/#1" is that layer's first effect); a command that needs a selected layer is disabled ("select a layer first") unless you pass {layer}; locked layers are skipped.`;

const GUIDES: Record<string, CraftGuide> = {
  vectorcraft: {
    app: "vectorcraft",
    verified: "0.17.0",
    brief: "VectorCraft: make a document first (file.new), read the drawing with document.inspect, coordinates in points with y down, export with document.export WITHOUT a path (the file lands in your file chain).",
    text: `${VECTORCRAFT}\n\n${COMMON}`,
  },
  filmcraft: {
    app: "filmcraft",
    verified: "0.13.0",
    brief: "FilmCraft: read with project.inspect / sequence.inspect, time in ticks (254016000000 per second; many commands take seconds), name clips with {clips:[id]}, exports run as jobs (poll jobs.list).",
    text: `${FILMCRAFT}\n\n${COMMON}`,
  },
  effectcraft: {
    app: "effectcraft",
    verified: "0.17.0",
    brief: "EffectCraft: comp.new, name every layer and refer to it by name, keyframes with prop.addKey (layer time), effects via effect.apply + prop.set \"effects/#1/<param>\", render with renderQueue.render {wait:false}.",
    text: `${EFFECTCRAFT}\n\n${COMMON}`,
  },
};

export function craftGuide(appId: string): CraftGuide | null {
  return GUIDES[appId] ?? null;
}

export const CRAFT_GUIDE_APPS: readonly string[] = Object.keys(GUIDES);
