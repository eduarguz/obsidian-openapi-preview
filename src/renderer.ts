import redocSource from 'redoc-standalone-source';
import redocLogo from './redoc-logo.svg';

// Preserve Redoc's attribution without fetching its logo from a CDN.
const offlineRedocSource = redocSource.replaceAll(
  'https://cdn.redoc.ly/redoc/logo-mini.svg',
  `data:image/svg+xml,${encodeURIComponent(redocLogo)}`,
);

interface RedocApi {
  init(spec: object, options: object, container: HTMLElement, callback: (error?: Error) => void): void;
}

export interface RenderedRedoc {
  destroy(): void;
}

/** Own document keeps Redoc's CSS, generated anchors, and scrolling out of Obsidian. */
export async function renderRedoc(
  container: HTMLElement,
  spec: object,
  title: string,
  signal?: AbortSignal,
): Promise<RenderedRedoc> {
  const document = container.ownerDocument;
  const frame = document.createElement('iframe');
  frame.className = 'openapi-preview-frame';
  frame.title = `OpenAPI documentation: ${title}`;
  frame.setAttribute('aria-label', frame.title);

  let cancel: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    cancel = () => {
      frame.remove();
      reject(new Error('OpenAPI rendering was cancelled.'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    frame.addEventListener('load', () => {
      try {
        const win = frame.contentWindow as (Window & { Redoc?: RedocApi }) | null;
        const doc = frame.contentDocument;
        if (!win || !doc) throw new Error('Could not initialize the documentation frame.');
        const style = document.defaultView!.getComputedStyle(container);
        const color = (variable: string, fallback: string) => {
          // Obsidian's accent includes CSS calc() expressions. Resolve them in
          // the browser before Redoc's color helpers try to parse the value.
          const probe = document.createElement('span');
          probe.style.display = 'none';
          probe.style.color = fallback;
          probe.style.color = style.getPropertyValue(variable).trim() || fallback;
          container.appendChild(probe);
          try {
            return document.defaultView!.getComputedStyle(probe).color;
          } finally {
            probe.remove();
          }
        };
        const background = color('--background-primary', '#ffffff');
        const foreground = color('--text-normal', '#222222');
        const secondary = color('--background-secondary', '#f5f5f5');
        const accent = color('--text-accent', '#526fff');
        const dark = document.body.classList.contains('theme-dark');
        doc.title = frame.title;
        const viewport = doc.createElement('meta');
        viewport.name = 'viewport';
        viewport.content = 'width=device-width, initial-scale=1';
        doc.head.appendChild(viewport);
        const css = doc.createElement('style');
        css.textContent = `html, body { margin: 0; background: ${background}; color: ${foreground}; color-scheme: ${dark ? 'dark' : 'light'}; }`;
        doc.head.appendChild(css);
        const mount = doc.createElement('div');
        doc.body.appendChild(mount);
        const script = doc.createElement('script');
        script.textContent = offlineRedocSource;
        doc.head.appendChild(script);
        if (!win.Redoc) throw new Error('The bundled Redoc renderer did not load.');
        win.Redoc.init(spec, {
          disableGoogleFont: true,
          hideDownloadButton: true,
          hideHostname: false,
          // Sanitize Markdown descriptions from the spec, including HTML.
          untrustedSpec: true,
          theme: {
            colors: {
              primary: { main: accent },
              text: { primary: foreground, secondary: color('--text-muted', '#777777') },
              border: { dark: color('--background-modifier-border', '#dddddd') },
            },
            typography: {
              fontFamily: style.fontFamily || 'sans-serif',
              fontSize: '14px',
              headings: { fontFamily: style.fontFamily || 'sans-serif' },
              code: { fontFamily: 'monospace', color: foreground, backgroundColor: secondary },
            },
            sidebar: { backgroundColor: secondary, textColor: foreground, width: '240px' },
            rightPanel: { backgroundColor: dark ? secondary : '#263238', textColor: '#ffffff' },
            schema: { nestedBackground: secondary },
          },
        }, mount, error => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    frame.addEventListener('error', () => reject(new Error('Could not load the documentation frame.')), { once: true });
  });
  frame.src = 'about:blank';
  if (signal?.aborted) cancel();
  else container.appendChild(frame);
  try {
    await ready;
    return { destroy: () => frame.remove() };
  } catch (error) {
    frame.remove();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
