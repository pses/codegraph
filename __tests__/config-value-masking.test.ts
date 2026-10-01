/**
 * maskConfigSource — the line-preserving view `codegraph_node` file mode serves
 * for a yaml/properties file: keys and harmless values (flags, numbers, short
 * words) as written, anything secret-shaped replaced by `<redacted>`.
 */
import { describe, it, expect } from 'vitest';
import { maskConfigSource, REDACTED } from '../src/config-masking';

const yaml = (src: string) => maskConfigSource(src, 'yaml');
const props = (src: string) => maskConfigSource(src, 'properties');

describe('maskConfigSource — yaml', () => {
  it('keeps line count and keys; shows flags, numbers, short words', () => {
    const src = 'features:\n  strasync: true\n  retries: 3\n  mode: STRICT\nserver:\n  port: 8080\n';
    const out = yaml(src);
    expect(out.text).toBe(src);
    expect(out.masked).toBe(0);
  });

  it('masks values of secret-named keys whatever they look like', () => {
    const out = yaml('db:\n  password: abc\n  api-key: "x"\n  clientSecret: s\n  token: t\n  user: admin\n');
    expect(out.text).toBe(
      `db:\n  password: ${REDACTED}\n  api-key: ${REDACTED}\n  clientSecret: ${REDACTED}\n  token: ${REDACTED}\n  user: admin\n`,
    );
    expect(out.masked).toBe(4);
  });

  it('keeps a bare ${ENV} placeholder but masks a literal default behind it', () => {
    const out = yaml('a:\n  password: ${DB_PASS}\n  secret: ${S:hunter2}\n');
    expect(out.text).toBe(`a:\n  password: \${DB_PASS}\n  secret: ${REDACTED}\n`);
  });

  it('masks the password inside a URL with credentials, keeps the rest', () => {
    const out = yaml('url: jdbc:postgresql://app:s3cr3t@db:5432/x\n');
    expect(out.text).toBe(`url: jdbc:postgresql://app:${REDACTED}@db:5432/x\n`);
  });

  it('masks long opaque tokens under innocuous keys', () => {
    const out = yaml('webhook: AKIA4F9X2Q7ZK3LMN8PRT1\ndescription: a long human sentence with many spaces in it\n');
    expect(out.text).toBe(`webhook: ${REDACTED}\ndescription: a long human sentence with many spaces in it\n`);
  });

  it('masks a block scalar under a secret key, and any PEM block', () => {
    const src = 'signing:\n  private-key: |\n    line1\n    line2\n  other: ok\ncert: |\n  -----BEGIN CERTIFICATE-----\n  MIIB\n  -----END CERTIFICATE-----\nnext: 1\n';
    const out = yaml(src);
    expect(out.text).toBe(
      `signing:\n  private-key: ${REDACTED}\n    ${REDACTED}\n    ${REDACTED}\n  other: ok\ncert: |\n  ${REDACTED}\n  ${REDACTED}\n  ${REDACTED}\nnext: 1\n`,
    );
  });

  it('masks list items under a secret key', () => {
    const out = yaml('passwords:\n  - one\n  - two\nnames:\n  - ann\n');
    expect(out.text).toBe(`passwords:\n  - ${REDACTED}\n  - ${REDACTED}\nnames:\n  - ann\n`);
  });

  it('masks a flow map that names a secret key', () => {
    const out = yaml('creds: {user: a, password: b}\n');
    expect(out.text).toBe(`creds: ${REDACTED}\n`);
  });

  it('applies the same rules to commented-out pairs', () => {
    const out = yaml('# password: oldpass\n# a plain comment\n');
    expect(out.text).toBe(`# password: ${REDACTED}\n# a plain comment\n`);
  });

  it('keeps a trailing comment after a harmless value', () => {
    expect(yaml('enabled: false # off for now\n').text).toBe('enabled: false # off for now\n');
  });
});

describe('maskConfigSource — properties', () => {
  it('masks secret keys, keeps flags', () => {
    const out = props('feature.strasync=true\nspring.datasource.password=SUPERSECRET123\nserver.port: 8080\n');
    expect(out.text).toBe(`feature.strasync=true\nspring.datasource.password=${REDACTED}\nserver.port: 8080\n`);
    expect(out.masked).toBe(1);
  });

  it('masks continuation lines of a masked value', () => {
    const out = props('app.secret=abc\\\n  def\nnext=1\n');
    expect(out.text).toBe(`app.secret=${REDACTED}\n  ${REDACTED}\nnext=1\n`);
  });
});
