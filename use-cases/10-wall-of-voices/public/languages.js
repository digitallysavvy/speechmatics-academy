/**
 * languages.js: the static language table.
 *
 * Melia (`model: "melia-1"`, `language: "multi"`) detects 55 languages and tags every word
 * with its own ISO code, on partials as well as finals. This table is what turns those
 * codes into something a room can read, keyed by the exact string Melia puts in
 * `alternatives[0].language`.
 *
 * `dir` drives CSS `direction` on captions. LanguageInfo carries a writing direction too,
 * but it arrives after the first word is already on screen, hence a static table, so no
 * RTL language paints left-to-right for a frame.
 */

export const MELIA_LANGUAGES = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'ba', name: 'Bashkir', nativeName: 'Башҡортса', dir: 'ltr' },
  { code: 'eu', name: 'Basque', nativeName: 'Euskara', dir: 'ltr' },
  { code: 'be', name: 'Belarusian', nativeName: 'Беларуская', dir: 'ltr' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', dir: 'ltr' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български', dir: 'ltr' },
  { code: 'yue', name: 'Cantonese', nativeName: '粵語', dir: 'ltr' },
  { code: 'ca', name: 'Catalan', nativeName: 'Català', dir: 'ltr' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski', dir: 'ltr' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', dir: 'ltr' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', dir: 'ltr' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', dir: 'ltr' },
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'eo', name: 'Esperanto', nativeName: 'Esperanto', dir: 'ltr' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', dir: 'ltr' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'gl', name: 'Galician', nativeName: 'Galego', dir: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', dir: 'ltr' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', dir: 'rtl' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', dir: 'ltr' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'ia', name: 'Interlingua', nativeName: 'Interlingua', dir: 'ltr' },
  { code: 'ga', name: 'Irish', nativeName: 'Gaeilge', dir: 'ltr' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', dir: 'ltr' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', dir: 'ltr' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', dir: 'ltr' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', dir: 'ltr' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'mt', name: 'Maltese', nativeName: 'Malti', dir: 'ltr' },
  { code: 'cmn', name: 'Mandarin', nativeName: '普通话', dir: 'ltr' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', dir: 'ltr' },
  { code: 'mn', name: 'Mongolian', nativeName: 'Монгол', dir: 'ltr' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk', dir: 'ltr' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', dir: 'rtl' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', dir: 'ltr' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', dir: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', dir: 'ltr' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', dir: 'ltr' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', dir: 'ltr' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', dir: 'ltr' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', dir: 'ltr' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', dir: 'ltr' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', dir: 'ltr' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', dir: 'rtl' },
  { code: 'ug', name: 'Uyghur', nativeName: 'ئۇيغۇرچە', dir: 'rtl' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', dir: 'ltr' },
  { code: 'cy', name: 'Welsh', nativeName: 'Cymraeg', dir: 'ltr' },
];
