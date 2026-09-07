/* eslint-disable no-console -- sonda de diagnostico: imprimir E o proposito */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type * as LiveKit from 'livekit-client';

/**
 * Nao e um teste de regressao: e uma sonda de medicao.
 *
 * Publica um stream sintetico e imprime os tres estagios do caminho — fonte,
 * encoder e receptor — para separar onde um eventual fps some.
 *
 * ATENCAO ao ler: a canvas e animada por setInterval numa aba de segundo
 * plano, que o Chromium limita. Ela costuma entregar ~15fps mesmo pedindo 30.
 * Por isso `fonteFps` e impresso: se encoderFps e o fps recebido acompanharem
 * a fonte, o pipeline esta limpo e o numero baixo e artefato do teste, nao do
 * app. O que importa aqui e a DIFERENCA entre os estagios, nunca o valor
 * absoluto.
 *
 * Rode com: npx playwright test latency-probe
 */

const UMD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/livekit-client/dist/livekit-client.umd.js',
);
const TOKEN_SERVER = 'http://127.0.0.1:8787';

test('sonda: jitter buffer e fps do lado receptor', async ({ browser, baseURL }) => {
  test.slow();

  const pubContext = await browser.newContext();
  const pub = await pubContext.newPage();
  await pub.goto(baseURL!);
  await pub.addScriptTag({ path: UMD });

  const room = await pub.evaluate(async (tokenServer) => {
    const lk = (globalThis as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
    const created = (await (await fetch(`${tokenServer}/api/rooms`, { method: 'POST' })).json()) as {
      roomId: string;
      token: string;
      livekitUrl: string;
    };

    // canvas 1920x1080 animado a 30fps, imitando tela em movimento
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    setInterval(() => {
      frame++;
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = '#3fb950';
      ctx.fillRect((frame * 17) % 1800, 400, 120, 120);
    }, 33);

    const stream = canvas.captureStream(30);
    const videoMst = stream.getVideoTracks()[0]!;
    videoMst.contentHint = 'motion';

    const r = new lk.Room();
    await r.connect(created.livekitUrl, created.token);
    await r.localParticipant.publishTrack(new lk.LocalVideoTrack(videoMst), {
      source: lk.Track.Source.ScreenShare,
      simulcast: false,
      // igual ao app: ScreenShare le screenShareEncoding, nao videoEncoding
      screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
      degradationPreference: 'maintain-framerate',
    });
    (globalThis as unknown as { __room: unknown }).__room = r;
    return created;
  }, TOKEN_SERVER);

  const viewer = await (
    await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  ).newPage();
  await viewer.goto(`/watch/${room.roomId}?debug=1`);
  await expect(viewer.locator('video.stage--on')).toBeVisible({ timeout: 20_000 });

  // deixa o jitter buffer estabilizar antes de ler
  await viewer.waitForTimeout(12_000);

  // Os tres estagios na mesma corrida. Sem isto nao da para saber se o fps
  // caiu na fonte, no encoder ou no transporte.
  const sender = await pub.evaluate(async () => {
    const r = (globalThis as unknown as { __room: LiveKit.Room }).__room;
    const publication = [...r.localParticipant.trackPublications.values()].find(
      (p) => p.kind === 'video',
    );
    const report = await publication?.track?.getRTCStatsReport();
    const out: Record<string, unknown> = {};
    report?.forEach((entry) => {
      const s = entry as RTCStats & Record<string, unknown>;
      if (s.type === 'media-source' && s.kind === 'video') {
        out.fonteFps = s.framesPerSecond;
        out.fonteQuadros = s.frames;
      }
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        out.encoderFps = s.framesPerSecond;
        out.quadrosEnviados = s.framesSent;
        out.gargalo = s.qualityLimitationReason;
        out.encoder = s.encoderImplementation;
        out.resolucao = `${String(s.frameWidth)}x${String(s.frameHeight)}`;
      }
    });
    return out;
  });

  const receiver = await viewer.evaluate(
    () => document.querySelector('.debug')?.textContent ?? '(painel ausente)',
  );

  console.log('\n===== CAMINHO COMPLETO (loopback, canvas 1920x1080 @30) =====');
  console.log('1. FONTE + ENCODER:', JSON.stringify(sender, null, 1));
  console.log('2. RECEPTOR:', receiver);
  console.log('=============================================================\n');

  await pubContext.close();
});
