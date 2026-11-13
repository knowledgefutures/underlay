import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const lines = `record line:   '{"id":' + JCS(id) + ',"type":' + JCS(type) + ',"data":' + JCS(data) + '}'
removal line:  '{"id":' + JCS(id) + ',"removed":true,"type":' + JCS(type) + '}'

size of a line = its length in bytes, without the "\\n"
record hash    = SHA-256(record line)     64 lowercase hex characters
a removal line has no hash`

const example = `{"id":"collection","type":"$meta","data":{"readme":"Weekly snapshot"}}
{"id":"Publication","type":"$schema","data":{"properties":{"title":{"type":"string"}},"type":"object"}}
{"id":"pub-001","type":"Publication","data":{"title":"Notes"}}
{"id":"pub-002","removed":true,"type":"Publication"}`

const reserved: [string, string, string][] = [
  ['$schema', 'a type name', 'that type’s JSON Schema'],
  ['$asset', 'an asset’s SHA-256, hex', '{"size": n, "mediaType": string or null}'],
  ['$meta', 'collection', 'the collection’s metadata object'],
]

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
  [
    'Envelope',
    'Not an object; a record whose members are not exactly id, type, and data; or a removal whose members are not exactly id, type, and "removed": true',
    'bad_envelope',
  ],
  ['Record id', 'Absent, not a string, empty, or over 1,024 UTF-8 bytes', 'bad_id'],
  [
    'Type',
    'Absent, not a string, empty, over 128 UTF-8 bytes, beginning with ".", or containing /, \\, U+0000–U+001F or U+007F; beginning with "$" other than a reserved type; beginning with a character that sorts before "$" (U+0020–U+0023); or "__proto__"',
    'bad_type',
  ],
  ['Record size', 'A record line longer than 8,388,608 bytes', 'record_too_large'],
]

export default function ProtocolRecords() {
  return (
    <DocsLayout title="Records and schemas" eyebrow="Protocol v3 · §2; v2 §§2–5, 7">
      <h2 id="canonical-json">Canonical JSON</h2>
      <p>
        Each hashed JSON document MUST be serialized as{' '}
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

      <h2 id="records-and-lines">Records and lines</h2>
      <p>
        A record is an <code>id</code> (string), a <code>type</code>, and <code>data</code> (any
        JSON value). Its <strong>key</strong> is (type, id), and within a version a key names at
        most one record. A sorted-record-file holds two kinds of line, each UTF-8 and ending with{' '}
        <code>\n</code>:
      </p>
      <CodeBlock>{lines}</CodeBlock>
      <ul>
        <li>
          A <strong>record line</strong> is the record&rsquo;s canonical form: a fixed envelope,{' '}
          <code>id</code>, <code>type</code>, <code>data</code> in that order, with only{' '}
          <code>data</code> canonicalized. The record hash is v2&rsquo;s.
        </li>
        <li>
          A <strong>removal line</strong> says the record with that key is removed.
        </li>
        <li>
          An upload&rsquo;s input lines are a record, <code>{'{"id", "type", "data"}'}</code>, or a
          removal, <code>{'{"id", "type", "removed": true}'}</code>, with exactly those members.
          Unlike v2, a line with any other member is refused: there is no <code>private</code>.
        </li>
      </ul>
      <p>Lines of one file, in key order:</p>
      <CodeBlock>{example}</CodeBlock>
      <p>
        Strings are not Unicode-normalized: <code>é</code> as U+00E9 and as U+0065 U+0301 are
        distinct ids.
      </p>

      <h2 id="reserved-types">Reserved types</h2>
      <p>
        Types that begin with <code>$</code> are reserved. A collection&rsquo;s schemas, assets, and
        metadata are rows of these types, in the same files as its records.
      </p>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Id</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {reserved.map(([type, id, data]) => (
            <tr key={type}>
              <td>
                <code>{type}</code>
              </td>
              <td>{id === 'collection' ? <code>{id}</code> : id}</td>
              <td>{data.startsWith('{') ? <code>{data}</code> : data}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        A publisher&rsquo;s own types MUST NOT begin with <code>$</code>, and no other{' '}
        <code>$</code> type is valid. A publisher&rsquo;s type also MUST NOT begin with a character
        that sorts before <code>$</code> (U+0020 to U+0023), so that the reserved rows sort before
        all records, and MUST NOT be <code>__proto__</code>. A type or an id with a lone surrogate
        is not valid.
      </p>

      <h2 id="key-order">Key order</h2>
      <p>
        Keys are ordered by type, then by id. Each is compared lexicographically by its UTF-8
        encoding, octet by octet, a proper prefix first: Unicode code point order. Implementations
        MUST NOT compare UTF-16 code units (ECMAScript&rsquo;s default <code>&lt;</code> and{' '}
        <code>sort()</code>), which differ when one string has a character at or above U+10000 where
        the other has one in U+E000–U+FFFF.
      </p>

      <h2 id="input-rules">Input rules</h2>
      <p>
        A writer MUST apply these rules to each line it uploads, and a server to each line it
        receives. They apply to the whole line and are evaluated on the source text, since a parsed
        value no longer carries the information they require. Schemas are subject to the duplicate
        key, unsafe integer, and lone surrogate rules.
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
        a non-object; <code>bad_id</code> or <code>bad_type</code>; <code>bad_envelope</code> for
        the wrong members; <code>record_too_large</code>. The codes are part of the protocol.
      </p>
      <p>
        The push API on underlay.org takes record lines under v2&rsquo;s envelope instead (see{' '}
        <Link to="/docs/protocol/push-and-pull#records-and-deletes">Push and pull</Link>), and
        writes them into files as the lines above.
      </p>

      <h2 id="schemas">Schemas</h2>
      <p>
        A type&rsquo;s schema is a JSON Schema draft-07 object, held as the data of the type&rsquo;s{' '}
        <code>$schema</code> row. <strong>Schema hash</strong> = SHA-256 of JCS(schema). A schema
        MUST be rejected if:
      </p>
      <ul>
        <li>its canonical form exceeds 262,144 bytes;</li>
        <li>
          any <code>pattern</code> or <code>patternProperties</code> key exceeds 256 UTF-16 code
          units. A <code>pattern</code> inside <code>const</code>, <code>enum</code>,{' '}
          <code>default</code> or <code>examples</code> is data and is not limited;
        </li>
        <li>the type it is given for is not a valid type;</li>
        <li>
          its root <code>private</code> is present and not a boolean, or a schema that is the value
          of a member of a <code>properties</code> object, at any depth, has{' '}
          <code>&quot;private&quot;: true</code>.
        </li>
      </ul>
      <p>
        A root <code>private</code> has no meaning in v3. On underlay.org a public collection
        refuses a schema with <code>&quot;private&quot;: true</code>: make the collection private
        instead.
      </p>
      <p>Within a version:</p>
      <ul>
        <li>
          A record of a publisher&rsquo;s type <code>T</code> MUST satisfy the <code>$schema</code>{' '}
          row for <code>T</code>, and a type with records MUST have a <code>$schema</code> row.
        </li>
        <li>
          When a commit changes a schema, each record of that type the version carries over MUST
          satisfy the new schema, and the commit MUST be refused if any does not. A change that only
          relaxes the schema (any document valid before is valid after) needs no check of the
          records carried over.
        </li>
        <li>A record whose line a server withholds is not checked.</li>
      </ul>

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
          each pattern compiles as an ECMAScript regular expression with the <code>u</code> flag;
        </li>
        <li>
          each <code>$ref</code> resolves within the schema or to the draft-07 meta-schema, against
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
          <code>$anchor</code> are honored;
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

      <h2 id="assets">Assets</h2>
      <p>
        An asset is a byte string named by its SHA-256. A collection holds an asset when a{' '}
        <code>$asset</code> row names it; the row&rsquo;s <code>size</code> MUST be the length of
        the bytes. A <code>$asset</code> row that adds an asset to a collection is accepted only if
        the asset&rsquo;s bytes were sent to that collection, or one of its versions already names
        it. That the server stores the bytes for another collection is never enough.
      </p>
      <p>
        Informative. On underlay.org a record refers to an asset by an object, at any depth of{' '}
        <code>data</code>, whose <code>$file</code> member is <code>sha256:</code> followed by 64
        lowercase hex characters. A push adds a <code>$asset</code> row for each asset its records
        refer to, or it declares, that the version before did not name.
      </p>
    </DocsLayout>
  )
}
