SELECT
  TO_HEX(MD5('hello')) AS md5_hash,
  TO_HEX(SHA1('hello')) AS sha1_hash,
  TO_HEX(SHA256('hello')) AS sha256_hash,
  TO_HEX(SHA512('hello')) AS sha512_hash
