import { useEffect, useRef, type JSX } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

type LineWavesProps = {
  speed?: number;
  innerLineCount?: number;
  outerLineCount?: number;
  warpIntensity?: number;
  rotation?: number;
  edgeFadeWidth?: number;
  colorCycleSpeed?: number;
  brightness?: number;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  enableMouseInteraction?: boolean;
  mouseInfluence?: number;
  color1?: string;
  color2?: string;
  color3?: string;
};

type Vec3Tuple = [number, number, number];

const vertexShader = `attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 0, 1); }`;

const fragmentShader = `precision highp float;
uniform float uTime;
uniform vec3 uResolution;
uniform float uSpeed;
uniform float uInnerLines;
uniform float uOuterLines;
uniform float uWarpIntensity;
uniform float uRotation;
uniform float uEdgeFadeWidth;
uniform float uColorCycleSpeed;
uniform float uBrightness;
uniform float uScale;
uniform vec2 uOffset;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec2 uMouse;
uniform float uMouseInfluence;
uniform bool uEnableMouse;
#define HALF_PI 1.5707963
float hashF(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
float smoothNoise(float x) { float i = floor(x); float f = fract(x); float u = f*f*(3.0-2.0*f); return mix(hashF(i), hashF(i+1.0), u); }
float displaceA(float coord, float t) { float r = sin(coord * 2.123) * 0.2; r += sin(coord * 3.234 + t * 4.345) * 0.1; r += sin(coord * 0.589 + t * 0.934) * 0.5; return r; }
float displaceB(float coord, float t) { float r = sin(coord * 1.345) * 0.3; r += sin(coord * 2.734 + t * 3.345) * 0.2; r += sin(coord * 0.189 + t * 0.934) * 0.3; return r; }
vec2 rotate2D(vec2 p, float angle) { float c = cos(angle); float s = sin(angle); return vec2(p.x*c - p.y*s, p.x*s + p.y*c); }
void main() {
  vec2 coords = gl_FragCoord.xy / uResolution.xy;
  coords = coords * 2.0 - 1.0;
  coords = coords * uScale + uOffset;
  coords = rotate2D(coords, uRotation);
  float halfT = uTime * uSpeed * 0.5;
  float fullT = uTime * uSpeed;
  float mouseWarp = 0.0;
  if (uEnableMouse) {
    vec2 mPos = rotate2D((uMouse * 2.0 - 1.0) * uScale + uOffset, uRotation);
    float mDist = length(coords - mPos);
    mouseWarp = uMouseInfluence * exp(-mDist * mDist * 4.0);
  }
  float warpAx = coords.x + displaceA(coords.y, halfT) * uWarpIntensity + mouseWarp;
  float warpAy = coords.y - displaceA(coords.x * cos(fullT) * 1.235, halfT) * uWarpIntensity;
  float warpBx = coords.x + displaceB(coords.y, halfT) * uWarpIntensity + mouseWarp;
  float warpBy = coords.y - displaceB(coords.x * sin(fullT) * 1.235, halfT) * uWarpIntensity;
  vec2 fieldA = vec2(warpAx, warpAy);
  vec2 fieldB = vec2(warpBx, warpBy);
  vec2 blended = mix(fieldA, fieldB, mix(fieldA, fieldB, 0.5));
  float fadeTop = smoothstep(uEdgeFadeWidth, uEdgeFadeWidth + 0.4, blended.y);
  float fadeBottom = smoothstep(-uEdgeFadeWidth, -(uEdgeFadeWidth + 0.4), blended.y);
  float vMask = 1.0 - max(fadeTop, fadeBottom);
  float tileCount = mix(uOuterLines, uInnerLines, vMask);
  float scaledY = blended.y * tileCount;
  float nY = smoothNoise(abs(scaledY));
  float ridge = pow(step(abs(nY - blended.x) * 2.0, HALF_PI) * cos(2.0 * (nY - blended.x)), 5.0);
  float lines = 0.0;
  for (float i = 1.0; i < 3.0; i += 1.0) {
    lines += pow(max(fract(scaledY), fract(-scaledY)), i * 2.0);
  }
  float pattern = vMask * lines;
  float cycleT = fullT * uColorCycleSpeed;
  float rChannel = (pattern + lines * ridge) * (cos(blended.y + cycleT * 0.234) * 0.5 + 1.0);
  float gChannel = (pattern + vMask * ridge) * (sin(blended.x + cycleT * 1.745) * 0.5 + 1.0);
  float bChannel = (pattern + lines * ridge) * (cos(blended.x + cycleT * 0.534) * 0.5 + 1.0);
  vec3 col = (rChannel * uColor1 + gChannel * uColor2 + bChannel * uColor3) * uBrightness;
  float alpha = clamp(length(col), 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`;

function hexToVec3(hex: string): Vec3Tuple {
  const normalized = hex.replace("#", "").padEnd(6, "f").slice(0, 6);

  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}

export function LineWaves({
  speed = 0.3,
  innerLineCount = 34,
  outerLineCount = 42,
  warpIntensity = 1,
  rotation = -45,
  edgeFadeWidth = 0,
  colorCycleSpeed = 1,
  brightness = 0.2,
  scale = 1,
  offsetX = 0,
  offsetY = 0,
  enableMouseInteraction = true,
  mouseInfluence = 2,
  color1 = "#ffffff",
  color2 = "#ffffff",
  color3 = "#ffffff",
}: LineWavesProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new Renderer({
      alpha: true,
      premultipliedAlpha: false,
      dpr: Math.min(window.devicePixelRatio, 2),
    });
    const { gl } = renderer;
    gl.clearColor(0, 0, 0, 0);

    const targetMouse: [number, number] = [0.5, 0.5];
    const currentMouse: [number, number] = [0.5, 0.5];
    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: [1, 1, 1] },
      uSpeed: { value: speed },
      uInnerLines: { value: innerLineCount },
      uOuterLines: { value: outerLineCount },
      uWarpIntensity: { value: warpIntensity },
      uRotation: { value: (rotation * Math.PI) / 180 },
      uEdgeFadeWidth: { value: edgeFadeWidth },
      uColorCycleSpeed: { value: colorCycleSpeed },
      uBrightness: { value: brightness },
      uScale: { value: scale },
      uOffset: { value: new Float32Array([offsetX, offsetY]) },
      uColor1: { value: hexToVec3(color1) },
      uColor2: { value: hexToVec3(color2) },
      uColor3: { value: hexToVec3(color3) },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uMouseInfluence: { value: mouseInfluence },
      uEnableMouse: { value: enableMouseInteraction },
    };

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms,
    });
    const mesh = new Mesh(gl, { geometry, program });

    gl.canvas.className = "line-waves-canvas";
    container.appendChild(gl.canvas);

    const handlePointerMove = (event: PointerEvent) => {
      const rect = gl.canvas.getBoundingClientRect();
      targetMouse[0] = (event.clientX - rect.left) / rect.width;
      targetMouse[1] = 1 - (event.clientY - rect.top) / rect.height;
    };
    const handlePointerLeave = () => {
      targetMouse[0] = 0.5;
      targetMouse[1] = 0.5;
    };

    const resize = () => {
      const width = container.offsetWidth || window.innerWidth;
      const height = container.offsetHeight || window.innerHeight;
      renderer.setSize(width, height);
      uniforms.uResolution.value = [
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / gl.canvas.height,
      ];
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("blur", handlePointerLeave);
    document.addEventListener("mouseleave", handlePointerLeave);
    window.addEventListener("resize", resize);
    resize();

    let raf = 0;
    const update = (time: number) => {
      uniforms.uTime.value = time * 0.001;
      if (enableMouseInteraction) {
        currentMouse[0] += 0.05 * (targetMouse[0] - currentMouse[0]);
        currentMouse[1] += 0.05 * (targetMouse[1] - currentMouse[1]);
        uniforms.uMouse.value[0] = currentMouse[0];
        uniforms.uMouse.value[1] = currentMouse[1];
      } else {
        uniforms.uMouse.value[0] = 0.5;
        uniforms.uMouse.value[1] = 0.5;
      }

      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("blur", handlePointerLeave);
      document.removeEventListener("mouseleave", handlePointerLeave);
      window.removeEventListener("resize", resize);
      if (gl.canvas.parentNode) {
        gl.canvas.parentNode.removeChild(gl.canvas);
      }
      program.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [
    brightness,
    color1,
    color2,
    color3,
    colorCycleSpeed,
    edgeFadeWidth,
    enableMouseInteraction,
    innerLineCount,
    mouseInfluence,
    offsetX,
    offsetY,
    outerLineCount,
    rotation,
    scale,
    speed,
    warpIntensity,
  ]);

  return <div className="line-waves" ref={containerRef} />;
}
