import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type * as LiveKit from 'livekit-client';

/**
 * Criterio de aceite da V0.4: varios espectadores ao mesmo tempo.
 *
 * Ate agora isso so tinha sido conferido a olho, com duas abas abertas na mao.
 * Aqui tres espectadores independentes (contextos separados, sem storage
 * compartilhado) assistem a mesma sala e cada um precisa ver o video E a
 * contagem correta.
 *
 * A contagem e o que mais tem chance de quebrar: ela vem de
 * `room.remoteParticipants` filtrado pelo prefixo de identidade, entao um
 * publisher contado como espectador, ou um espectador que sai sem ser
 * removido, aparecem aqui.
 */

const UMD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/livekit-client/dist/livekit-client.umd.js',
);
const TOKEN_SERVER = 'http://127.0.0.1:8787';

interface CreatedRoom {
  roomId: string;
  token: string;
  livekitUrl: string;
}

async function startFakePublisher(page: Page, baseURL: string): Promise<CreatedRoom> {
  await page.goto(baseURL);
  await page.addScriptTag({ path: UMD });

  return page.evaluate(async (tokenServer) => {
    const lk = (globalThis as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;
    const created = (await (await fetch(`${tokenServer}/api/rooms`, { method: 'POST' })).json()) as {
      roomId: string;
      token: string;
      livekitUrl: string;
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 360, frameRate: 15 },
      audio: true,
    });

    const room = new lk.Room();
    await room.connect(created.livekitUrl, created.token);
    await room.localParticipant.publishTrack(new lk.LocalVideoTrack(stream.getVideoTracks()[0]!), {
      source: lk.Track.Source.ScreenShare,
      simulcast: false,
      screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
    });
    (globalThis as unknown as { __room: unknown }).__room = room;
    return created;
  }, TOKEN_SERVER);
}

/** Cada espectador em seu proprio contexto: sessoes de verdade, nao abas irmas. */
async function abrirEspectador(browser: Browser, roomId: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/watch/${roomId}`);
  await expect(page.locator('video.stage--on')).toBeVisible({ timeout: 25_000 });
  return page;
}

const contador = (page: Page) => page.getByTitle('Espectadores');

test.describe('varios espectadores', () => {
  test.beforeAll(async ({ request }) => {
    const health = await request.get(`${TOKEN_SERVER}/health`).catch(() => null);
    test.skip(!health?.ok(), 'token-server sem LiveKit — rode `pnpm livekit:dev`');
  });

  test('tres pessoas assistem a mesma sala e a contagem bate para todas', async ({
    browser,
    baseURL,
  }) => {
    test.slow();

    const pubContext = await browser.newContext();
    const pub = await pubContext.newPage();

    let room: CreatedRoom;
    try {
      room = await startFakePublisher(pub, baseURL!);
    } catch (err) {
      await pubContext.close();
      test.skip(true, `LiveKit indisponivel: ${String(err)}`);
      return;
    }

    const a = await abrirEspectador(browser, room.roomId);
    await expect(contador(a)).toHaveText(/1/, { timeout: 15_000 });

    const b = await abrirEspectador(browser, room.roomId);
    const c = await abrirEspectador(browser, room.roomId);

    // Os tres precisam convergir para 3. O publisher NAO conta como
    // espectador: se contasse, apareceria 4 aqui.
    for (const page of [a, b, c]) {
      await expect(contador(page)).toHaveText(/3/, { timeout: 20_000 });
    }

    // Todos continuam de fato recebendo video, nao so conectados ao sinal.
    for (const page of [a, b, c]) {
      await expect
        .poll(
          () =>
            page
              .locator('video.stage--on')
              .evaluate((el: HTMLVideoElement) => el.videoWidth > 0 && !el.paused),
          { timeout: 15_000 },
        )
        .toBe(true);
    }

    // Um sai: os que ficam precisam perceber, senao o numero so cresce.
    await c.context().close();
    for (const page of [a, b]) {
      await expect(contador(page)).toHaveText(/2/, { timeout: 25_000 });
    }

    await pubContext.close();
    await a.context().close();
    await b.context().close();
  });
});
