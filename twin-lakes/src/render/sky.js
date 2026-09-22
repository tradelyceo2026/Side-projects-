// Sky: a 256x128 look-up table of single-scattered radiance, re-rendered when the sun moves, shared by the
// sky dome, the water reflections and the aerial perspective. Plus the sun disc, stars and a cloud layer.

import * as THREE from '../../vendor/three.module.js';
import { ATMOSPHERE_GLSL, SKYLUT_GLSL, sunTransmittance } from './atmosphere.js';
import { LIGHT_GLSL } from './glsl.js';

export class Sky {
  constructor(renderer, shared) {
    this.renderer = renderer;
    this.shared = shared;
    this.lut = new THREE.WebGLRenderTarget(256, 128, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
    });
    shared.tSkyLut.value = this.lut.texture;
    this.lutScene = new THREE.Scene();
    this.lutCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.lutMat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uAlt: { value: 300 }, uHaze: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        ${ATMOSPHERE_GLSL}
        ${SKYLUT_GLSL}
        uniform vec3 uSun; uniform float uAlt; uniform float uHaze;
        varying vec2 vUv;
        void main() {
          vec3 d = skyLutDir(vUv);
          vec3 c = scatterSky(uAlt, d, uSun, uHaze);
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.lutScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lutMat));
    this.lastKey = '';

    // dome
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
      uniforms: { ...shared, uSunDisc: { value: 1 } },
      side: THREE.BackSide, depthWrite: false,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
          gl_Position = p.xyww;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        ${LIGHT_GLSL}
        varying vec3 vDir;
        uniform float uSunDisc;
        float starField(vec3 d) {
          vec3 q = d * 380.0;
          vec3 i = floor(q);
          float h = fract(sin(dot(i, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          vec3 f = fract(q) - 0.5;
          float s = smoothstep(0.08, 0.0, length(f)) * step(0.9965, h);
          return s * (0.4 + 0.6 * fract(h * 97.0));
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec3 d = normalize(vDir);
          vec3 c = skyColour(d);
          float mu = dot(d, uSunDir);
          // sun disc with limb darkening
          float disc = smoothstep(0.99996, 0.999985, mu);
          c += uSunColor * disc * 40.0 * uSunDisc;
          c += uSunColor * pow(max(mu, 0.0), 800.0) * 2.0;
          if (d.y > 0.0) c += vec3(0.8, 0.85, 1.0) * starField(d) * uNight * 1.5 * smoothstep(0.0, 0.1, d.y);
          // below the horizon (seen from altitude beyond the terrain): hazy ground colour
          if (d.y < 0.0) c = mix(c, uGroundAmbient * 0.6, smoothstep(0.0, -0.05, d.y) * 0.3);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    this.dome = dome;

    // cloud layer: a large plane at the cloud base following the camera, shaded from fbm noise
    const clouds = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), new THREE.ShaderMaterial({
      uniforms: { ...shared },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        ${LIGHT_GLSL}
        uniform float uCloudCover;
        uniform vec2 uCloudOffset;
        varying vec3 vWorld;
        float cloudDensity(vec2 p) {
          vec2 q = (p + uCloudOffset) / 2600.0;
          float n = fbm(q) * 0.65 + fbm(q * 3.1 + 5.0) * 0.35;
          return smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.18, n);
        }
        void main() {
          #include <logdepthbuf_fragment>
          float d = cloudDensity(vWorld.xz);
          if (d < 0.01) discard;
          float dist = distance(vWorld, uCam);
          // self-shadowing: sample toward the sun
          float d2 = cloudDensity(vWorld.xz + uSunDir.xz * 350.0);
          bool below = uCam.y < vWorld.y;
          float lit = below ? mix(0.95, 0.35, d) : mix(1.1, 0.75, d2);
          vec3 col = (uSunColor * lit * max(uSunDir.y + 0.1, 0.05) * 1.6 + uAmbient * 1.2) * 0.85;
          col = aerial(col, vWorld);
          float a = d * (1.0 - smoothstep(25000.0, 60000.0, dist));
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    clouds.rotation.x = -Math.PI / 2;
    clouds.scale.set(140000, 140000, 1);
    clouds.frustumCulled = false;
    clouds.renderOrder = 10;
    this.clouds = clouds;
  }

  /** Update lighting uniforms for a sun direction and camera; re-render the LUT when needed. */
  update(sunDir, camPos, haze = 1) {
    const s = this.shared;
    s.uSunDir.value.set(...sunDir);
    const alt = Math.max(0, camPos.y);
    const key = `${sunDir.map((v) => v.toFixed(3)).join(',')}|${Math.round(alt / 250)}|${haze.toFixed(2)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lutMat.uniforms.uSun.value.set(...sunDir);
      this.lutMat.uniforms.uAlt.value = alt;
      this.lutMat.uniforms.uHaze.value = haze;
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.lut);
      this.renderer.render(this.lutScene, this.lutCam);
      this.renderer.setRenderTarget(prev);
    }
    // direct sun colour at the camera altitude, and a sky/ground ambient term
    const tr = sunTransmittance(alt, sunDir);
    const I = 1.75;
    const elev = sunDir[1];
    const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.08);
    s.uSunColor.value.set(tr[0] * I, tr[1] * I, tr[2] * I).multiplyScalar(THREE.MathUtils.smoothstep(elev, -0.03, 0.02));
    s.uSkyIntensity.value = 9.0;
    const amb = 0.36 * day + 0.03;
    s.uAmbient.value.set(0.55 * amb + tr[0] * 0.05 * day, 0.66 * amb + tr[1] * 0.05 * day, 0.95 * amb + tr[2] * 0.03 * day);
    s.uGroundAmbient.value.set(0.22, 0.26, 0.2).multiplyScalar(amb * 2);
    s.uNight.value = 1 - THREE.MathUtils.smoothstep(elev, -0.14, -0.02);
    this.dome.position.copy(camPos);
    this.clouds.position.set(camPos.x, s.uCloudBase.value, camPos.z);
    this.clouds.visible = s.uCloudCover.value > 0.02;
  }
}

export function makeSharedUniforms() {
  return {
    tSkyLut: { value: null },
    uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uAmbient: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
    uGroundAmbient: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
    uSkyIntensity: { value: 20 },
    uFogDensity: { value: 1 / 40000 },
    uTime: { value: 0 },
    uNight: { value: 0 },
    tShadow: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowOn: { value: 0 },
    uCloudCover: { value: 0.0 },
    uCloudBase: { value: 1500 },
    uCloudOffset: { value: new THREE.Vector2() },
    tLights: { value: null },
    uLightsRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
}
