// Copy this file to public/config.js and fill in your own project's values
// (Supabase Dashboard → Project Settings → API), or run `npm run config`
// with SUPABASE_URL and SUPABASE_ANON_KEY set in the environment.
//
// The anon key is designed to be public: it ships to every browser, and the
// Row Level Security policies in supabase/schema.sql are what keep the data
// safe. NEVER put the service_role key here.
//
// public/config.js is git-ignored. Without it the app runs in demo mode and
// keeps reports in this browser only.
window.DERELICT_WATCH_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
};
