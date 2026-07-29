import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://tradetill.com',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'auto' },
});
