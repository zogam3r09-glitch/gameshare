import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type * as LiveKit from 'livekit-client';

/**
 * Teste de ponta a ponta do criterio de aceite "o viewer recebe video".
 *
 * Um publisher sintetico (camera fake do Chromium) substitui o Electron: a
 * permissao nativa de captura do Windows continua fora da automacao, mas todo
 * o caminho token-server -> LiveKit -> viewer e exercitado de verdade.
 *
 * Regressao que este teste trava: `TrackSubscribed` dispara DURANTE
 * `room.connect()`, antes do codigo pos-connect. Se o pos-connect sobrescrever
 * a fase, o viewer fica preso em "Aguardando transmissao..." para sempre.
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

/** Publica video + audio falsos na sala e resolve quando o SFU confirmou. */
async function startFakePublisher(page: Page, baseURL: string): Promise<CreatedRoom> {
  await page.goto(baseURL);
  await page.addScriptTag({ path: UMD });

  return page.evaluate(async (tokenServer) => {
    const lk = (globalThis as unknown as { LivekitClient: typeof LiveKit }).LivekitClient;

    const res = await fetch(`${tokenServer}/api/rooms`, { method: 'POST' });
    const created = (await res.json()) as CreatedRoom;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 360, frameRate: 15 },
      audio: true,
    });

    const room = new lk.Room();
    await room.connect(created.livekitUrl, created.token);

    await room.localParticipant.publishTrack(new lk.LocalVideoTrack(stream.getVideoTracks()[0]!), {
      source: lk.Track.Source.ScreenShare,
      simulcast: false,
    });
    await room.localParticipant.publishTrack(new lk.LocalAudioTrack(stream.getAudioTracks()[0]!), {
      source: lk.Track.Source.ScreenShareAudio,
    });

    // mantem vivo enquanto a pagina existir
    (globalThis as unknown as { __room: unknown }).__room = room;
    return created;
  }, TOKEN_SERVER);
}

test.describe('publisher -> viewer', () => {
  test.beforeAll(async ({ request }) => {
    const health = await request.get(`${TOKEN_SERVER}/health`).catch(() => null);
    test.skip(
      !health?.ok(),
      'token-server sem LiveKit configurado — rode `pnpm livekit:dev` para exercitar este teste',
    );
  });

  test('o viewer sai de "Aguardando" e reproduz o video publicado', async ({
    browser,
    baseURL,
  }) => {
    const pubContext = await browser.newContext();
    const pub = await pubContext.newPage();

    let room: CreatedRoom;
    try {
      room = await startFakePublisher(pub, baseURL!);
    } catch (err) {
      await pubContext.close();
      test.skip(true, `LiveKit indisponivel para o publisher sintetico: ${String(err)}`);
      return;
    }

    const viewer = await (
      await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    ).newPage();
    await viewer.goto(`/watch/${room.roomId}`);

    // O <video> so ganha a classe --on quando a fase e "playing".
    // O bug fazia isto nunca acontecer: a fase voltava para "waiting".
    const video = viewer.locator('video.stage--on');
    await expect(video).toBeVisible({ timeout: 20_000 });

    await expect(viewer.getByText('Aguardando transmissão…')).toBeHidden();

    // E precisa estar realmente decodificando, nao so anexado.
    await expect
      .poll(
        () =>
          video.evaluate(
            (el: HTMLVideoElement) => el.videoWidth > 0 && el.readyState >= 2 && !el.paused,
          ),
        { timeout: 20_000, message: 'o elemento <video> nunca comecou a decodificar' },
      )
      .toBe(true);

    // O publisher nao deve ser contado como espectador.
    await expect(viewer.getByTitle('Espectadores')).toHaveText(/1/);

    // A pagina nunca rola: o video fica travado no tamanho da janela.
    // Regressao: como item de grid, o <video> crescia ate a altura da propria
    // proporcao (1080px a 1920 de largura) e empurrava a barra para fora,
    // gerando 36px de scroll vertical em 1920x1080.
    await expect
      .poll(() =>
        viewer.evaluate(() => {
          const d = document.documentElement;
          return { v: d.scrollHeight - d.clientHeight, h: d.scrollWidth - d.clientWidth };
        }),
      )
      .toEqual({ v: 0, h: 0 });

    // E ocupa a tela inteira: a barra flutua por cima, nao rouba altura.
    expect(await video.boundingBox()).toMatchObject({ width: 1920, height: 1080 });

    // Encerramento explicito, exatamente como o botao ENCERRAR TRANSMISSAO do
    // desktop: desconecta e manda encerrar a sala no SFU.
    // (Fechar a aba na marra e outro caso: sem sinal de "leave", o SFU so
    // percebe depois do timeout da peer connection, ~20s.)
    await pub.evaluate(async () => {
      await (globalThis as unknown as { __room: { disconnect(): Promise<void> } }).__room.disconnect();
    });

    const ended = await pub.request.post(`${TOKEN_SERVER}/api/rooms/${room.roomId}/end`, {
      headers: { authorization: `Bearer ${room.token}` },
    });
    expect(ended.ok()).toBe(true);
    expect((await ended.json()) as { deleted: boolean }).toMatchObject({ deleted: true });

    // Publisher saiu => o viewer avisa, em vez de congelar.
    await expect(viewer.getByRole('heading', { name: 'Transmissão encerrada' })).toBeVisible({
      timeout: 20_000,
    });

    await pubContext.close();
  });

  test('um espectador nao consegue encerrar a transmissao de outra pessoa', async ({
    browser,
    baseURL,
    request,
  }) => {
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

    // o que um espectador consegue obter com o link e apenas um token de viewer
    const viewerToken = (await (
      await request.post(`${TOKEN_SERVER}/api/rooms/${room.roomId}/viewer-token`)
    ).json()) as { token: string };

    const attempt = await request.post(`${TOKEN_SERVER}/api/rooms/${room.roomId}/end`, {
      headers: { authorization: `Bearer ${viewerToken.token}` },
    });
    expect(attempt.status()).toBe(403);

    // e a transmissao continua no ar para quem esta assistindo
    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(`/watch/${room.roomId}`);
    await expect(viewer.locator('video.stage--on')).toBeVisible({ timeout: 20_000 });

    await pubContext.close();
  });
});
