// Style tokens, matched to the Knowall internal CRM so the two tools look
// like one family. Change the look here rather than in each component.
//
//   orange   #EF5F24  Knowall orange: logo and the active sidebar item
//   blue     #1976D2  primary buttons, links, page titles, progress
//   sidebar  #1F2633  left navigation (dark on both themes)
//   title    #111111  headings        body  #333333
//   border   #DDDDDD  card and table borders
const brand = {
  50: '#FEF4EE', 100: '#FDE4D6', 200: '#FBCBB2', 300: '#F7A985', 400: '#F38354',
  500: '#EF5F24', 600: '#D94F17', 700: '#B8400F', 800: '#8F320C', 900: '#6F270B',
};

const blue = {
  50: '#EEF5FD', 100: '#DCEBFB', 200: '#BBDEFB', 300: '#90CAF9', 400: '#42A5F5',
  500: '#2196F3', 600: '#1976D2', 700: '#1565C0', 800: '#0D47A1', 900: '#0A3A85', 950: '#062555',
};

// Neutral greys with no blue tint, anchored on the brand text and border values.
const neutral = {
  50: '#FAFAFA', 100: '#F4F5F7', 200: '#DDDDDD', 300: '#C9C9C9', 400: '#8F8F8F',
  500: '#6B6B6B', 600: '#555555', 700: '#333333', 800: '#111111', 900: '#0A0A0A', 950: '#050505',
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand,
        blue,
        // The components use indigo for a few accents next to blue; the CRM
        // has a single blue, so both names share one scale.
        indigo: blue,
        slate: neutral,
        sidebar: { DEFAULT: '#1F2633', hover: '#2A3344', line: '#313B4E', text: '#C9D1DE' },
      },
    },
  },
  plugins: [],
};
