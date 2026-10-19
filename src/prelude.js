// prelude.js: loads three.js and the post-processing add-ons from the CDN.

const $ = (id) => document.getElementById(id);
function setProgress(p, msg) {
  const b = $('loadbar'); if (b) b.style.transform = `scaleX(${p})`;
  if (msg && $('loadmsg')) $('loadmsg').textContent = msg;
}
function fatal(msg) {
  if ($('loadmsg')) $('loadmsg').textContent = msg;
  const l = $('loading'); if (l) l.classList.add('failed');
}

let THREE, EffectComposer = null, RenderPass = null, UnrealBloomPass = null, ShaderPass = null, OutputPass = null;
setProgress(0.1, 'Loading 3D engine');
try {
  THREE = await import('three');
} catch (e) {
  console.error(e);
  fatal('The 3D engine could not be loaded. Check your connection and reload the page.');
  throw e;
}
setProgress(0.45, 'Loading effects');
try {
  ({ EffectComposer } = await import('three/addons/postprocessing/EffectComposer.js'));
  ({ RenderPass } = await import('three/addons/postprocessing/RenderPass.js'));
  ({ UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js'));
  ({ ShaderPass } = await import('three/addons/postprocessing/ShaderPass.js'));
  ({ OutputPass } = await import('three/addons/postprocessing/OutputPass.js'));
} catch (e) {
  // The game still runs without bloom and speed effects.
  console.warn('Post-processing unavailable, using plain rendering', e);
  EffectComposer = null;
}
setProgress(0.7, 'Building the world');
