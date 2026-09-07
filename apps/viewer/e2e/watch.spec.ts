import { expect, test } from '@playwright/test';

const VALID_ROOM = 'ABCD-EFGH';

test('link malformado mostra erro em vez de tela branca', async ({ page }) => {
  await page.goto('/watch/nao-e-um-codigo');
  await expect(page.getByRole('heading', { name: 'Link inválido' })).toBeVisible();
});

test('rota raiz tambem nao quebra', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Link inválido' })).toBeVisible();
});

test('link valido pede token e mostra um estado explicito', async ({ page }) => {
  const tokenRequest = page.waitForRequest(
    (r) => r.url().includes(`/api/rooms/${VALID_ROOM}/viewer-token`) && r.method() === 'POST',
  );

  await page.goto(`/watch/${VALID_ROOM}`);
  await tokenRequest;

  // Com LiveKit no ar => "Aguardando transmissão…". Sem LiveKit => erro explicito.
  // Os dois sao aceitaveis; o que nao pode e ficar em branco.
  await expect(
    page
      .getByText('Aguardando transmissão…')
      .or(page.getByRole('heading', { name: 'Não foi possível assistir' })),
  ).toBeVisible({ timeout: 30_000 });

  await expect(page.getByText(VALID_ROOM)).toBeVisible();
});

test('o roomId em minusculas e normalizado', async ({ page }) => {
  await page.goto(`/watch/${VALID_ROOM.toLowerCase()}`);
  await expect(page.getByText(VALID_ROOM)).toBeVisible();
});

test('a pagina nunca expoe o API secret do LiveKit', async ({ page }) => {
  await page.goto(`/watch/${VALID_ROOM}`);
  await page.waitForTimeout(1500);
  const html = await page.content();
  expect(html).not.toContain('LIVEKIT_API_SECRET');
  expect(html).not.toContain('devsecret');
});
