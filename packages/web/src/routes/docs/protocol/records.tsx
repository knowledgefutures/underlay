import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const canonicalForm = `'{"id":' + JCS(id) + ',"type":' + JCS(type) + ',"data":' + JCS(data) + '}'

record hash = SHA-256(canonical form)     64 lowercase hex characters
record size = length of the canonical form in bytes`

const recordLine = `{"id":"pub-001","type":"Publication","data":{"title":"Notes","pdf":{"$file":"sha256:9f86d0…"}}}
{"id":"pub-002","type":"Publication","data":{"title":"Draft"},"private":true}`

const rules: [string, string, string][] = [
  [
    'Syntax',
    'Not JSON as defined by RFC 8259, including an unterminated string or invalid escape',
    'syntax',
  ],
  [
    'Duplicate keys',
    'An object with two members whose keys are equal after unescaping',
    'duplicate_key',
  ],
  [
    'Unsafe integers',
    'An integer literal (no fraction, no exponent) of magnitude above 2⁵³ − 1. Literals with a fraction or exponent are accepted as IEEE 754 binary64',
    'unsafe_integer',
  ],
  [
    'Lone surrogates',
    'A UTF-16 surrogate code unit, literal or \\u-escaped, not part of a pair, in a string or key',
    'lone_surrogate',
  ],
  [
    'Depth',
    'The line nesting more than 65 levels: each object or array is a level and the envelope is level 1, so data may nest 64',
    'too_deep',
  ],
  ['Envelope', 'Not an object, no data, or a private that is not a boolean', 'bad_envelope'],
  ['Record id', 'Absent, not a string, empty, or over 1,024 UTF-8 bytes', 'bad_id'],
  [
    'Type slug',
    'Absent, not a string, empty, over 128 UTF-8 bytes, beginning with ".", or containing /, \\, U+0000–U+001F or U+007F',
    'bad_type',
  ],
  ['Record size', 'A canonical form longer than 8,388,608 bytes', 'record_too_large'],
]

export default function ProtocolRecords() {
  return (
    <DocsLayout title="Records and schemas" eyebrow="Protocol v2 · §§2–6">
      <h2 id="canonical-json">Canonical JSON</h2>
      <p>
        Every hashed JSON document MUST be serialized as{' '}
        <a href="https://www.rfc-editor.org/rfc/rfc8785">RFC 8785 (JCS)</a>: no insignificant
        whitespace; strings escaped as by <code>JSON.stringify</code>; numbers serialized as by
        ECMAScript <code>Number.prototype.toString</code>, with <code>-0</code> as <code>0</code>;
        object members ordered by the UTF-16 code units of their keys.
      </p>
      <p>
        Note: ECMAScript objects enumerate integer-like keys (<code>&quot;9&quot;</code>,{' '}
        <code>&quot;10&quot;</code>) first regardless of insertion order. Sorting keys into a new
        object and calling <code>JSON.stringify</code> does not produce JCS; an implementation MUST
        emit object members as strings itself.
      </p>

      <h2 id="input-rules">Input rules</h2>
      <p>
        A client MUST apply these rules to every record line it publishes, and a server to every
        record line it receives in a publication. They apply to the whole line, including members
        that are otherwise ignored, and are evaluated on the source text, since a parsed value no
        longer carries the information they require. Schemas are subject to the duplicate key,
        unsafe integer and lone surrogate rules.
      </p>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>Rejected if</th>
            <th>Code</th>
          </tr>
        </thead>
        <tbody>
          {rules.map(([rule, what, code]) => (
            <tr key={rule}>
              <td>{rule}</td>
              <td>{what}</td>
              <td>
                <code>{code}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        A line that breaks several rules is reported with the code of the first in this order: the
        first violation in text order of an unterminated string or invalid escape (
        <code>syntax</code>), <code>duplicate_key</code>, <code>unsafe_integer</code>,{' '}
        <code>lone_surrogate</code> or <code>too_deep</code>, whether or not the text is otherwise
        JSON; <code>syntax</code> for any other text that is not JSON; <code>bad_envelope</code> for
        a non-object; <code>bad_id</code>; <code>bad_type</code>; <code>bad_envelope</code> for
        absent <code>data</code> or a non-boolean <code>private</code>;{' '}
        <code>record_too_large</code>. The codes are part of the protocol.
      </p>
      <p>
        Members of a record line other than <code>id</code>, <code>type</code>, <code>data</code>{' '}
        and <code>private</code> MUST be ignored. Strings are not Unicode-normalized: <code>é</code>{' '}
        as U+00E9 and as U+0065 U+0301 are distinct ids.
      </p>

      <h2 id="records">Records</h2>
      <p>
        A record is an <code>id</code> (string), a <code>type</code> (type slug) and{' '}
        <code>data</code> (any JSON value). It is published as one NDJSON line; an optional{' '}
        <code>&quot;private&quot;: true</code> assigns it to the private set and is not part of the
        record.
      </p>
      <CodeBlock>{recordLine}</CodeBlock>
      <p>
        The <strong>canonical form</strong> is a fixed envelope, <code>id</code>, <code>type</code>,{' '}
        <code>data</code> in that order, with only <code>data</code> canonicalized:
      </p>
      <CodeBlock>{canonicalForm}</CodeBlock>
      <p>
        Within a version, a (type, id) pair MUST identify at most one record, across both access
        sets.
      </p>

      <h2 id="schemas">Schemas</h2>
      <p>
        A type&rsquo;s schema is a JSON Schema draft-07 object. <strong>Schema hash</strong> =
        SHA-256 of JCS(schema). A schema MUST be rejected if:
      </p>
      <ul>
        <li>
          its root <code>private</code> is present and not a boolean;
        </li>
        <li>
          a schema that is the value of a member of a <code>properties</code> object, at any depth,
          has <code>&quot;private&quot;: true</code> (field-level privacy is not supported);
        </li>
        <li>its canonical form exceeds 262,144 bytes;</li>
        <li>
          any <code>pattern</code> or <code>patternProperties</code> key exceeds 256 UTF-16 code
          units. A <code>pattern</code> inside <code>const</code>, <code>enum</code>,{' '}
          <code>default</code> or <code>examples</code> is data and is not limited;
        </li>
        <li>the slug it is given under is not a valid type slug.</li>
      </ul>
      <p>
        A root <code>&quot;private&quot;: true</code> makes the type private.
      </p>

      <h2 id="validation">Validation</h2>
      <p>A schema MUST be rejected unless:</p>
      <ul>
        <li>
          its root <code>$schema</code>, if present, is{' '}
          <code>http://json-schema.org/draft-07/schema</code>, with or without a trailing{' '}
          <code>#</code>;
        </li>
        <li>it is valid against the draft-07 meta-schema;</li>
        <li>
          every pattern compiles as an ECMAScript regular expression with the <code>u</code> flag;
        </li>
        <li>
          every <code>$ref</code> resolves within the schema or to the draft-07 meta-schema, against
          the base URI <code>https://schema.underlay.invalid/</code> unless a <code>$id</code> sets
          another.
        </li>
      </ul>
      <p>Records are validated under draft-07 with these refinements:</p>
      <ul>
        <li>
          keywords adjacent to <code>$ref</code> apply, as in draft 2019-09;
        </li>
        <li>
          keywords draft-07 does not define are ignored (<code>unevaluatedProperties</code>,{' '}
          <code>prefixItems</code>, draft-04 <code>id</code>, …); <code>$defs</code> and{' '}
          <code>$anchor</code> are honoured;
        </li>
        <li>
          <code>multipleOf</code> m accepts x when r = x mod m satisfies |r| &lt; 1.1920929 × 10⁻⁷
          or |m − r| &lt; 1.1920929 × 10⁻⁷;
        </li>
        <li>string length is measured in Unicode code points;</li>
        <li>
          <code>format</code> constrains strings only, for the formats ajv-formats 3.0 defines in
          full mode (<code>date-time</code> and <code>time</code> require a time zone); other format
          names are ignored.
        </li>
      </ul>
      <p>Only the verdict is normative; error messages are not.</p>

      <h2 id="files">Files</h2>
      <p>
        <strong>File hash</strong> = SHA-256 of the file&rsquo;s bytes. A record references a file
        through any object, at any depth of <code>data</code>, whose <code>$file</code> member is a
        string <code>sha256:</code> followed by 64 lowercase hex characters. A reference object is
        not searched further; an object whose <code>$file</code> has any other value is not a
        reference and is searched as usual.
      </p>
    </DocsLayout>
  )
}
