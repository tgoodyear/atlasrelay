// The provider marks on the sign-in buttons (components/ProviderLogo.tsx draws them). Each is the
// provider's own published artwork, copied path for path with only whitespace changed, and drawn
// inline so the page fetches nothing for them (the site's CSP is 'self'). Nothing in this file may
// touch the DOM, so the unit tests can check it.
//
// These marks are trademarks of their owners. The repository's licence does not cover them; each
// is used here only to label that provider's sign-in button, which is the use each provider's
// guidelines below provide for, and must not be changed (no recolouring, stretching or redrawing).
//
//   GitHub     The Invertocat, white, from GitHub_Logos.zip ("GitHub_Invertocat_White.svg") on
//              https://brand.github.com/foundations/logo. GitHub's logo guidelines allow the mark
//              to link to GitHub or to say a site works with GitHub, in white on a dark background.
//   Microsoft  The four-square logo, "ms-symbollockup_mssymbol_19.svg" from "Sign in with Microsoft
//              branding guidelines", https://learn.microsoft.com/entra/identity-platform/howto-add-branding-in-apps,
//              which offers it for sign-in buttons and asks only that it is not altered. Its four
//              <rect>s are written here as the same squares in path form.
//   Google     The standard-colour "G", as Google's own "Sign in with Google" button draws it (the
//              Google Identity Services client, https://accounts.google.com/gsi/client).
//              https://developers.google.com/identity/branding-guidelines allows it on a sign-in
//              button, in standard colour, on white, at 18 px, with the button text beside it.
//   ORCID      The iD icon in its black and white colourway, "ORCID-iD_icon-bw-vector.svg" from
//              ORCID's iD icon graphics, https://orcid.figshare.com/articles/figure/ORCID_iD_icon_graphics/5008697
//              (CC0; ORCID and the iD icon remain ORCID, Inc. trademarks).
//              https://info.orcid.org/documentation/integration-guide/orcid-id-display-guidelines
//              offers green, black and white, and reversed colourways and asks for buttons that
//              connect to ORCID to use one unaltered. The green icon's disc would vanish into the
//              ORCID-green button, so the button uses the black and white icon, which matches its
//              dark text.

import type { ProviderId } from './signin';

export interface LogoShape {
  d: string;
  fill: string;
}

export interface Logo {
  viewBox: string;
  /** Drawn size in CSS pixels, square. */
  size: number;
  shapes: readonly LogoShape[];
}

export const LOGOS: Record<ProviderId, Logo> = {
  github: {
    viewBox: '0 0 98 96',
    size: 20,
    shapes: [
      {
        fill: '#FFFFFF',
        d: 'M41.4395 69.3848C28.8066 67.8535 19.9062 58.7617 19.9062 46.9902C19.9062 42.2051 21.6289 37.0371 24.5 33.5918C23.2559 30.4336 23.4473 23.7344 24.8828 20.959C28.7109 20.4805 33.8789 22.4902 36.9414 25.2656C40.5781 24.1172 44.4062 23.543 49.0957 23.543C53.7852 23.543 57.6133 24.1172 61.0586 25.1699C64.0254 22.4902 69.2891 20.4805 73.1172 20.959C74.457 23.543 74.6484 30.2422 73.4043 33.4961C76.4668 37.1328 78.0937 42.0137 78.0937 46.9902C78.0937 58.7617 69.1934 67.6621 56.3691 69.2891C59.623 71.3945 61.8242 75.9883 61.8242 81.252L61.8242 91.2051C61.8242 94.0762 64.2168 95.7031 67.0879 94.5547C84.4102 87.9512 98 70.6289 98 49.1914C98 22.1074 75.9883 6.69539e-07 48.9043 4.309e-07C21.8203 1.92261e-07 -1.9479e-07 22.1074 -4.3343e-07 49.1914C-6.20631e-07 70.4375 13.4941 88.0469 31.6777 94.6504C34.2617 95.6074 36.75 93.8848 36.75 91.3008L36.75 83.6445C35.4102 84.2188 33.6875 84.6016 32.1562 84.6016C25.8398 84.6016 22.1074 81.1563 19.4277 74.7441C18.375 72.1602 17.2266 70.6289 15.0254 70.3418C13.877 70.2461 13.4941 69.7676 13.4941 69.1934C13.4941 68.0449 15.4082 67.1836 17.3223 67.1836C20.0977 67.1836 22.4902 68.9063 24.9785 72.4473C26.8926 75.2227 28.9023 76.4668 31.2949 76.4668C33.6875 76.4668 35.2187 75.6055 37.4199 73.4043C39.0469 71.7773 40.291 70.3418 41.4395 69.3848Z',
      },
    ],
  },
  aad: {
    viewBox: '0 0 21 21',
    size: 20,
    shapes: [
      { fill: '#F25022', d: 'M1 1h9v9H1z' },
      { fill: '#00A4EF', d: 'M1 11h9v9H1z' },
      { fill: '#7FBA00', d: 'M11 1h9v9h-9z' },
      { fill: '#FFB900', d: 'M11 11h9v9h-9z' },
    ],
  },
  google: {
    viewBox: '0 0 48 48',
    size: 18,
    shapes: [
      { fill: '#EA4335', d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z' },
      { fill: '#4285F4', d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z' },
      { fill: '#FBBC05', d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z' },
      { fill: '#34A853', d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z' },
    ],
  },
  orcid: {
    viewBox: '0 0 256 256',
    size: 20,
    shapes: [
      { fill: '#000000', d: 'M256,128c0,70.7-57.3,128-128,128C57.3,256,0,198.7,0,128C0,57.3,57.3,0,128,0C198.7,0,256,57.3,256,128z' },
      { fill: '#FFFFFF', d: 'M86.3,186.2H70.9V79.1h15.4v48.4V186.2z' },
      { fill: '#FFFFFF', d: 'M108.9,79.1h41.6c39.6,0,57,28.3,57,53.6c0,27.5-21.5,53.6-56.8,53.6h-41.8V79.1z M124.3,172.4h24.5 c34.9,0,42.9-26.5,42.9-39.7c0-21.5-13.7-39.7-43.7-39.7h-23.7V172.4z' },
      { fill: '#FFFFFF', d: 'M88.7,56.8c0,5.5-4.5,10.1-10.1,10.1c-5.6,0-10.1-4.6-10.1-10.1c0-5.6,4.5-10.1,10.1-10.1 C84.2,46.7,88.7,51.3,88.7,56.8z' },
    ],
  },
};
