import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { fetchLineage } from '../api';
import type { LineageDetailResponse, LineageNodeDto } from '../types';

/**
 * Evolutionary lineage tree.
 *
 * Drawn as an SVG generation graph: each column is a generation, each dot an organism, each line a
 * parent→child descent. Dead branches stay visible — a lineage's history is the point, and hiding
 * the ends of it would misrepresent what survival cost.
 */

export interface LineageTreeProps {
  readonly lineageId: string | undefined;
  readonly onSelectOrganism: (organismId: string) => void;
  readonly onClose: () => void;
}

const COLUMN_WIDTH = 74;
const ROW_HEIGHT = 26;
const MARGIN = 22;

export function LineageTree(props: LineageTreeProps): JSX.Element | null {
  const [detail, setDetail] = useState<LineageDetailResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const { lineageId } = props;

  useEffect(() => {
    if (lineageId === undefined) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void fetchLineage(lineageId)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load the lineage.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lineageId]);

  const layout = useMemo(() => (detail ? layoutNodes(detail.nodes) : undefined), [detail]);

  if (lineageId === undefined) return null;

  return (
    <section className="panel panel--lineage" aria-label="Lineage tree">
      <header className="panel__header">
        <h2>{detail?.name ?? 'Lineage'}</h2>
        <button type="button" className="button button--ghost" onClick={props.onClose}>
          Close
        </button>
      </header>

      {loading && (
        <p className="muted" role="status">
          Loading lineage…
        </p>
      )}
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {detail && (
        <>
          <dl className="facts facts--inline">
            <dt>Founded</dt>
            <dd>tick {detail.foundedAtTick}</dd>
            <dt>Generations</dt>
            <dd>{detail.generations}</dd>
            <dt>Living</dt>
            <dd>{detail.livingCount}</dd>
            <dt>Births / deaths</dt>
            <dd>
              {detail.births} / {detail.deaths}
            </dd>
          </dl>

          {detail.nodes.length === 0 ? (
            <p className="muted">This lineage has no recorded organisms yet.</p>
          ) : (
            layout && (
              <div className="lineage__scroll">
                <svg
                  className="lineage__svg"
                  width={layout.width}
                  height={layout.height}
                  role="img"
                  aria-label={`Descent graph with ${detail.nodes.length} organisms across ${detail.generations} generations`}
                >
                  {layout.edges.map((edge) => (
                    <path
                      key={edge.key}
                      d={edge.path}
                      className="lineage__edge"
                      fill="none"
                      strokeWidth={1}
                    />
                  ))}
                  {layout.points.map((point) => (
                    <g key={point.node.organismId}>
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r={point.node.diedAtTick === undefined ? 5 : 3.5}
                        className={
                          point.node.diedAtTick === undefined
                            ? 'lineage__node lineage__node--alive'
                            : 'lineage__node lineage__node--dead'
                        }
                        onClick={() => props.onSelectOrganism(point.node.organismId)}
                      >
                        <title>
                          {`Generation ${point.node.generation}, born tick ${point.node.bornAtTick}` +
                            (point.node.diedAtTick === undefined
                              ? ' — alive'
                              : ` — died tick ${point.node.diedAtTick}${
                                  point.node.causeOfDeath === undefined
                                    ? ''
                                    : ` (${point.node.causeOfDeath})`
                                }`)}
                        </title>
                      </circle>
                    </g>
                  ))}
                </svg>
              </div>
            )
          )}

          <ul className="legend">
            <li>
              <span className="legend__dot legend__dot--alive" /> living
            </li>
            <li>
              <span className="legend__dot legend__dot--dead" /> died
            </li>
          </ul>

          {detail.nextCursor !== undefined && (
            <p className="muted small">
              Showing the first {detail.nodes.length} organisms of a longer history.
            </p>
          )}
        </>
      )}
    </section>
  );
}

interface Layout {
  readonly width: number;
  readonly height: number;
  readonly points: readonly { node: LineageNodeDto; x: number; y: number }[];
  readonly edges: readonly { key: string; path: string }[];
}

function layoutNodes(nodes: readonly LineageNodeDto[]): Layout {
  const byGeneration = new Map<number, LineageNodeDto[]>();
  for (const node of nodes) {
    const list = byGeneration.get(node.generation);
    if (list) list.push(node);
    else byGeneration.set(node.generation, [node]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  const generations = [...byGeneration.keys()].sort((a, b) => a - b);

  for (const generation of generations) {
    const column = byGeneration.get(generation) ?? [];
    column.sort((a, b) => a.bornAtTick - b.bornAtTick);
    maxRows = Math.max(maxRows, column.length);
    column.forEach((node, index) => {
      positions.set(node.organismId, {
        x: MARGIN + generations.indexOf(generation) * COLUMN_WIDTH,
        y: MARGIN + index * ROW_HEIGHT,
      });
    });
  }

  const edges: { key: string; path: string }[] = [];
  for (const node of nodes) {
    if (node.parentOrganismId === undefined) continue;
    const from = positions.get(node.parentOrganismId);
    const to = positions.get(node.organismId);
    if (!from || !to) continue;
    const midX = (from.x + to.x) / 2;
    edges.push({
      key: `${node.parentOrganismId}->${node.organismId}`,
      path: `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`,
    });
  }

  const points = nodes
    .map((node) => {
      const position = positions.get(node.organismId);
      return position ? { node, x: position.x, y: position.y } : undefined;
    })
    .filter((p): p is { node: LineageNodeDto; x: number; y: number } => p !== undefined);

  return {
    width: MARGIN * 2 + Math.max(1, generations.length - 1) * COLUMN_WIDTH,
    height: MARGIN * 2 + Math.max(1, maxRows - 1) * ROW_HEIGHT,
    points,
    edges,
  };
}
