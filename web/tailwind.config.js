import colors from 'tailwindcss/colors';

// Knowall IT brand tokens. Every colour the app uses comes from here, so the
// brand is changed in this one file.
//
//   orange  #EF5F24  primary / accent          (brand 500 and 600)
//   fill    #FDE4D6  light orange fill         (brand 100)
//   title   #111111  titles and headers        (slate 800)
//   body    #333333  body text                 (slate 700)
//   border  #DDDDDD  borders and dividers      (slate 200)
//
// Not used, per the brand rules: navy #1A1A2E, red #E63946, Office orange #ED7D31.
const brand = {
  50: '#FEF4EE',
  100: '#FDE4D6',
  200: '#FBCBB2',
  300: '#F7A985',
  400: '#F38354',
  500: '#EF5F24',
  600: '#EF5F24',
  700: '#D14E18',
  800: '#A93A0C',
  900: '#7A2B0A',
  950: '#45170A',
};

// Neutral greys with no blue tint, anchored on the brand text and border values.
const neutral = {
  50: '#FAFAFA',
  100: '#F5F5F5',
  200: '#DDDDDD',
  300: '#C9C9C9',
  400: '#8F8F8F',
  500: '#6B6B6B',
  600: '#555555',
  700: '#333333',
  800: '#111111',
  900: '#0A0A0A',
  950: '#050505',
};

// Small orange text on white needs a darker shade than the brand orange to
// stay readable (#EF5F24 on white is only 3.3:1), so the text shades are
// stepped down. Fills, buttons and bars keep the exact brand orange.
const brandText = { 600: '#C4440F', 700: '#A93A0C' };

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand,
        // The components were written with Tailwind's blue / indigo as the
        // accent and slate as the grey. Pointing those names at the brand
        // scales rebrands every screen without touching each component.
        blue: brand,
        indigo: brand,
        slate: neutral,
        // Warnings move from amber to yellow so they can't be mistaken for
        // the orange accent.
        amber: colors.yellow,
      },
      textColor: {
        brand: brandText,
        blue: brandText,
        indigo: brandText,
      },
    },
  },
  plugins: [],
};
