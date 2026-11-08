Self-signed certificate for the local TLS origin used by test/proxy-dispatcher.test.mjs.
Generated once with:

  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout localhost-key.pem -out localhost-cert.pem \
    -days 3650 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"

It is a throwaway test fixture; nothing outside this test trusts it.
