SELECT
  'tab\there' AS tab_escape,
  'line1\nline2' AS newline_escape,
  'quote\'s' AS escaped_quote,
  '\u0041\u0042\u0043' AS unicode_escape,
  '\x41\x42' AS hex_escape,
  r'raw\nstring' AS raw_no_escape
