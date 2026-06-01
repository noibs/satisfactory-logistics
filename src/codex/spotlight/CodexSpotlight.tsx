import {
  IconBackspace,
  IconBox,
  IconBuildingFactory2,
  IconChevronRight,
  IconCornerDownLeft,
  IconHomeCog,
  IconStairsUp,
  IconToolsKitchen2,
} from '@tabler/icons-react';
import { Command } from 'cmdk';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import type { Factory } from '@/factories/Factory';
import { useGameFactories } from '@/games/store/gameFactoriesSelectors';
import {
  AllFactoryBuildings,
  type FactoryBuilding,
} from '@/recipes/FactoryBuilding';
import {
  AllFactoryItems,
  AllFactoryItemsMap,
  type FactoryItem,
  FactoryItemForm,
} from '@/recipes/FactoryItem';
import { AllFactoryRecipes, type FactoryRecipe } from '@/recipes/FactoryRecipe';
import { FactoryItemImage } from '@/recipes/ui/FactoryItemImage';
import { type TierGroup, TierGroups } from '../tiers/tierUnlocks';
import './cmdk.css';

type Page = 'items' | 'buildings' | 'recipes' | 'factories' | 'tiers';

const validItems = AllFactoryItems.filter(
  item => item.form !== FactoryItemForm.Invalid,
);

// Per-category result caps. Generous enough to feel "complete", small enough
// that the DOM never balloons past ~70 rows in the unified view.
const CAP_FACTORIES = 10;
const CAP_ITEMS = 25;
const CAP_BUILDINGS = 15;
const CAP_RECIPES = 25;
const CAP_TIERS = 10;
// Single-category pages can show more since they are the only group rendered.
const CAP_SINGLE = 100;

// Minimum top-result score for the Tiers group to render in the unified
// view. Fuzzy matching against long milestone-name strings yields many
// false-positive low scores; this threshold keeps tiers out of unrelated
// queries while letting "tier 4" or a full milestone name through.
const TIER_MIN_SCORE = 0.5;

// ---------- Search index (built once at module load) ----------

interface Indexed<T> {
  item: T;
  haystack: string; // pre-lowercased, space-separated searchable fields
  primary: string; // pre-lowercased display name, used for prefix bonus
  // FICSMAS items pollute generic queries (the recipe ids contain "Manuf"
  // etc.); fade their score so they only surface when the query actually
  // matches them strongly.
  fade?: boolean;
}

function buildItemIndex(): Indexed<FactoryItem>[] {
  return validItems.map(i => ({
    item: i,
    haystack: `${i.displayName} ${i.name} ${i.id} ${i.form}`.toLowerCase(),
    primary: i.displayName.toLowerCase(),
    fade: i.isFicsmas,
  }));
}

interface IndexedBuilding extends Indexed<FactoryBuilding> {
  category: string;
}

function buildBuildingIndex(): IndexedBuilding[] {
  return AllFactoryBuildings.map(b => {
    const category = b.powerGenerator
      ? 'Power Generator'
      : b.extractor
        ? 'Extractor'
        : b.conveyor || b.pipeline
          ? 'Logistics'
          : 'Production';
    return {
      item: b,
      category,
      haystack: `${b.name} ${b.id} ${category}`.toLowerCase(),
      primary: b.name.toLowerCase(),
    };
  });
}

function buildRecipeIndex(): Indexed<FactoryRecipe>[] {
  return AllFactoryRecipes.map(r => {
    const productNames = r.products
      .map(p => AllFactoryItemsMap[p.resource]?.displayName ?? p.resource)
      .join(' ');
    const fade = r.products.some(
      p => AllFactoryItemsMap[p.resource]?.isFicsmas,
    );
    return {
      item: r,
      haystack: `${r.name} ${r.id} ${productNames}`.toLowerCase(),
      primary: r.name.toLowerCase(),
      fade,
    };
  });
}

interface IndexedTier extends Indexed<TierGroup> {
  milestoneNames: string;
}

function buildTierIndex(): IndexedTier[] {
  return TierGroups.map(g => {
    const milestoneNames = g.schematics.map(s => s.name).join(', ');
    const schematicIds = g.schematics.map(s => s.id).join(' ');
    return {
      item: g,
      milestoneNames,
      haystack:
        `tier ${g.tier} ${milestoneNames} ${schematicIds}`.toLowerCase(),
      primary: `tier ${g.tier}`.toLowerCase(),
    };
  });
}

const ITEM_INDEX = buildItemIndex();
const BUILDING_INDEX = buildBuildingIndex();
const RECIPE_INDEX = buildRecipeIndex();
const TIER_INDEX = buildTierIndex();

// `value` string helpers — must match what each row passes to `Command.Item`
// so the parent can drive cmdk's controlled selection by computing the
// top-scoring row globally (the visual group order is fixed; the highlight
// follows the highest-scoring match wherever it lives).
const valueOfFactory = (f: Factory) => `${f.name ?? 'Unnamed Factory'} ${f.id}`;
const valueOfItem = (i: FactoryItem) => `${i.displayName} ${i.id}`;
const valueOfBuilding = (b: FactoryBuilding) => `${b.name} ${b.id}`;
const valueOfRecipe = (r: FactoryRecipe) => `${r.name} ${r.id}`;
const valueOfTier = (g: TierGroup, milestoneNames: string) =>
  `Tier ${g.tier} ${milestoneNames}`;

// Factories are per-game and change at runtime; built inside the hook.
interface IndexedFactory {
  item: Factory;
  haystack: string;
  primary: string;
  outputs: Array<{ resource: string; amount?: number | null }>;
}

function buildFactoryIndex(factories: Factory[]): IndexedFactory[] {
  return factories.map(f => {
    const outputs = (f.outputs ?? []).filter(
      (o): o is typeof o & { resource: string } => Boolean(o?.resource),
    );
    const outputNames = outputs
      .map(o => AllFactoryItemsMap[o.resource]?.displayName ?? o.resource)
      .join(' ');
    const name = f.name || 'Unnamed Factory';
    return {
      item: f,
      outputs,
      haystack: `${name} ${f.id} ${outputNames}`.toLowerCase(),
      primary: name.toLowerCase(),
    };
  });
}

// ---------- Fuzzy scorer ----------
//
// Port of cmdk's `command-score` (MIT, https://github.com/pacocoursey/cmdk).
// Inlined so we can keep `shouldFilter={false}` and our per-category caps
// while still getting cmdk's tolerant fuzzy scoring (subsequence match,
// word-boundary bonus, transposition fallback). Inputs are expected to be
// pre-lowercased; case-mismatch penalty is therefore a no-op (fine for
// ranking).

const SCORE_CONTINUE_MATCH = 1;
const SCORE_SPACE_WORD_JUMP = 0.9;
const SCORE_NON_SPACE_WORD_JUMP = 0.8;
const SCORE_CHARACTER_JUMP = 0.17;
const SCORE_TRANSPOSITION = 0.1;
const PENALTY_SKIPPED = 0.999;
const PENALTY_NOT_COMPLETE = 0.99;
const IS_GAP_RE = /[\\/_+.#"@[({&]/;
const COUNT_GAPS_RE = /[\\/_+.#"@[({&]/g;
const IS_SPACE_RE = /[\s-]/;
const COUNT_SPACE_RE = /[\s-]/g;

function scoreInner(
  s: string,
  q: string,
  si: number,
  qi: number,
  memo: Record<string, number>,
): number {
  if (qi === q.length) {
    return si === s.length ? SCORE_CONTINUE_MATCH : PENALTY_NOT_COMPLETE;
  }
  const key = `${si},${qi}`;
  const cached = memo[key];
  if (cached !== undefined) return cached;

  const qc = q.charAt(qi);
  let index = s.indexOf(qc, si);
  let high = 0;

  while (index >= 0) {
    let score = scoreInner(s, q, index + 1, qi + 1, memo);
    if (score > high) {
      if (index === si) {
        score *= SCORE_CONTINUE_MATCH;
      } else if (IS_GAP_RE.test(s.charAt(index - 1))) {
        score *= SCORE_NON_SPACE_WORD_JUMP;
        const breaks = s.slice(si, index - 1).match(COUNT_GAPS_RE);
        if (breaks && si > 0) score *= PENALTY_SKIPPED ** breaks.length;
      } else if (IS_SPACE_RE.test(s.charAt(index - 1))) {
        score *= SCORE_SPACE_WORD_JUMP;
        const breaks = s.slice(si, index - 1).match(COUNT_SPACE_RE);
        if (breaks && si > 0) score *= PENALTY_SKIPPED ** breaks.length;
      } else {
        score *= SCORE_CHARACTER_JUMP;
        if (si > 0) score *= PENALTY_SKIPPED ** (index - si);
      }
    }
    // Transposition / one-off recovery: allow a single skipped query char.
    if (
      (score < SCORE_TRANSPOSITION &&
        s.charAt(index - 1) === q.charAt(qi + 1)) ||
      (q.charAt(qi + 1) === q.charAt(qi) &&
        s.charAt(index - 1) !== q.charAt(qi))
    ) {
      const trans = scoreInner(s, q, index + 1, qi + 2, memo);
      if (trans * SCORE_TRANSPOSITION > score) {
        score = trans * SCORE_TRANSPOSITION;
      }
    }
    if (score > high) high = score;
    index = s.indexOf(qc, index + 1);
  }
  memo[key] = high;
  return high;
}

function commandScore(haystack: string, query: string): number {
  return scoreInner(haystack, query, 0, 0, {});
}

// ---------- Search runner ----------

interface Scored<T> {
  entry: T;
  score: number;
}

// Multiplier applied to FICSMAS (seasonal) entries. They were dominating
// generic queries; halving their score keeps them findable without making
// them outrank the obvious matches.
const FICSMAS_FADE = 0.5;

/**
 * Score every entry against the query and return the top `cap` results
 * sorted by score (descending). Entries scoring 0 are dropped (same
 * threshold cmdk uses). When the query is empty, returns the first `cap`
 * entries with score 1.
 */
function filterIndex<
  T extends { haystack: string; primary: string; fade?: boolean },
>(index: T[], query: string, cap: number): Scored<T>[] {
  if (!query?.trim()) {
    const n = Math.min(index.length, cap);
    const out: Scored<T>[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { entry: index[i], score: 1 };
    return out;
  }
  const q = query.toLowerCase().trim();

  const scored: Scored<T>[] = [];
  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    let score = commandScore(entry.haystack, q);
    if (score <= 0) continue;
    if (entry.fade) score *= FICSMAS_FADE;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length > cap ? scored.slice(0, cap) : scored;
}

let openSpotlightFn: (() => void) | null = null;

export function openSpotlight() {
  openSpotlightFn?.();
}

export function CodexSpotlight() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState<Page[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const factories = useGameFactories();
  const deferredSearch = useDeferredValue(search);
  // Controlled selection so cmdk doesn't keep a stale highlight when our
  // sort reorders items (cmdk's auto-reset doesn't run with shouldFilter
  // off).
  const [selectedValue, setSelectedValue] = useState('');

  const page = pages[pages.length - 1];

  // Factory index, rebuilt only when the factories array reference changes.
  const factoryIndex = useMemo(() => buildFactoryIndex(factories), [factories]);

  useEffect(() => {
    openSpotlightFn = () => setOpen(true);
    return () => {
      openSpotlightFn = null;
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  // Scroll back to top whenever the query or active page changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deferredSearch/page are scroll triggers
  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [deferredSearch, page]);

  const pushPage = useCallback((p: Page) => {
    setPages(prev => [...prev, p]);
    setSearch('');
  }, []);

  const popPage = useCallback(() => {
    setPages(prev => prev.slice(0, -1));
    setSearch('');
  }, []);

  const select = useCallback(
    (path: string) => {
      setOpen(false);
      setPages([]);
      setSearch('');
      navigate(path);
    },
    [navigate],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={o => {
        setOpen(o);
        if (!o) {
          setPages([]);
          setSearch('');
        }
      }}
      label="Codex Search"
      shouldFilter={false}
      value={selectedValue}
      onValueChange={setSelectedValue}
      loop
    >
      {pages.length > 0 && (
        <div className="cmdk-header">
          {pages.map(p => (
            <span key={p} className="cmdk-badge">
              {p === 'factories'
                ? 'Factories'
                : p === 'items'
                  ? 'Items'
                  : p === 'buildings'
                    ? 'Buildings'
                    : p === 'tiers'
                      ? 'Tiers'
                      : 'Recipes'}
            </span>
          ))}
        </div>
      )}

      <Command.Input
        ref={inputRef}
        value={search}
        onValueChange={setSearch}
        placeholder={
          !page
            ? 'Search...'
            : page === 'factories'
              ? 'Search factories...'
              : page === 'items'
                ? 'Search items...'
                : page === 'buildings'
                  ? 'Search buildings...'
                  : page === 'tiers'
                    ? 'Search tiers...'
                    : 'Search recipes...'
        }
        onKeyDown={(e: React.KeyboardEvent) => {
          if (
            pages.length > 0 &&
            (e.key === 'Escape' || (e.key === 'Backspace' && !search))
          ) {
            e.preventDefault();
            popPage();
          }
        }}
      />

      <Command.List ref={listRef}>
        <Command.Empty>No results found.</Command.Empty>

        {!page && !deferredSearch && (
          <RootPage pushPage={pushPage} factoryCount={factories.length} />
        )}
        {!page && deferredSearch && (
          <UnifiedResultsPage
            query={deferredSearch}
            factoryIndex={factoryIndex}
            select={select}
            onTopValue={setSelectedValue}
          />
        )}
        {page === 'factories' && (
          <FactoriesPage
            query={deferredSearch}
            factoryIndex={factoryIndex}
            select={select}
            onTopValue={setSelectedValue}
          />
        )}
        {page === 'items' && (
          <ItemsPage
            query={deferredSearch}
            select={select}
            onTopValue={setSelectedValue}
          />
        )}
        {page === 'buildings' && (
          <BuildingsPage
            query={deferredSearch}
            select={select}
            onTopValue={setSelectedValue}
          />
        )}
        {page === 'recipes' && (
          <RecipesPage
            query={deferredSearch}
            select={select}
            onTopValue={setSelectedValue}
          />
        )}
        {page === 'tiers' && (
          <TiersPage
            query={deferredSearch}
            select={select}
            onTopValue={setSelectedValue}
          />
        )}
      </Command.List>

      <div className="cmdk-footer">
        <span>{page === 'factories' ? 'Factories' : 'Codex'}</span>
        <span>
          {pages.length > 0 ? (
            <>
              <kbd>
                <IconCornerDownLeft size={12} />
              </kbd>{' '}
              select &nbsp;{' '}
              <kbd>
                <IconBackspace size={12} />
              </kbd>{' '}
              back &nbsp; <kbd>esc</kbd> close
            </>
          ) : (
            <>
              <kbd>
                <IconCornerDownLeft size={12} />
              </kbd>{' '}
              select &nbsp; <kbd>esc</kbd> close
            </>
          )}
        </span>
      </div>
    </Command.Dialog>
  );
}

function RootPage({
  pushPage,
  factoryCount,
}: {
  pushPage: (p: Page) => void;
  factoryCount: number;
}) {
  return (
    <Command.Group heading="Categories">
      <Command.Item value="factories" onSelect={() => pushPage('factories')}>
        <div className="cmdk-item-icon">
          <IconHomeCog size={22} />
        </div>
        <div className="cmdk-item-content">
          <span className="cmdk-item-label">Factories</span>
          <span className="cmdk-item-description">
            {factoryCount} {factoryCount === 1 ? 'factory' : 'factories'} in the
            current game
          </span>
        </div>
        <IconChevronRight size={16} className="cmdk-item-chevron" />
      </Command.Item>

      <Command.Item value="items" onSelect={() => pushPage('items')}>
        <div className="cmdk-item-icon">
          <IconBox size={22} />
        </div>
        <div className="cmdk-item-content">
          <span className="cmdk-item-label">Items</span>
          <span className="cmdk-item-description">
            {validItems.length} producible items, resources, and materials
          </span>
        </div>
        <IconChevronRight size={16} className="cmdk-item-chevron" />
      </Command.Item>

      <Command.Item value="buildings" onSelect={() => pushPage('buildings')}>
        <div className="cmdk-item-icon">
          <IconBuildingFactory2 size={22} />
        </div>
        <div className="cmdk-item-content">
          <span className="cmdk-item-label">Buildings</span>
          <span className="cmdk-item-description">
            {AllFactoryBuildings.length} production buildings, logistics, and
            extractors
          </span>
        </div>
        <IconChevronRight size={16} className="cmdk-item-chevron" />
      </Command.Item>

      <Command.Item value="recipes" onSelect={() => pushPage('recipes')}>
        <div className="cmdk-item-icon">
          <IconToolsKitchen2 size={22} />
        </div>
        <div className="cmdk-item-content">
          <span className="cmdk-item-label">Recipes</span>
          <span className="cmdk-item-description">
            {AllFactoryRecipes.length} default, alternate, and MAM recipes
          </span>
        </div>
        <IconChevronRight size={16} className="cmdk-item-chevron" />
      </Command.Item>

      <Command.Item value="tiers" onSelect={() => pushPage('tiers')}>
        <div className="cmdk-item-icon">
          <IconStairsUp size={22} />
        </div>
        <div className="cmdk-item-content">
          <span className="cmdk-item-label">Tiers</span>
          <span className="cmdk-item-description">
            {TierGroups.length} HUB tiers and what each milestone unlocks
          </span>
        </div>
        <IconChevronRight size={16} className="cmdk-item-chevron" />
      </Command.Item>
    </Command.Group>
  );
}

type OnTopValue = (value: string) => void;

function useReportTop(value: string, onTopValue: OnTopValue) {
  // Layout effect rather than effect: cmdk's controlled `value` is read
  // during its own layout effect. If we set it post-paint, the user sees a
  // frame with no selection and Enter does nothing.
  useLayoutEffect(() => {
    if (value) onTopValue(value);
  }, [value, onTopValue]);
}

function FactoriesPage({
  query,
  factoryIndex,
  select,
  onTopValue,
}: {
  query: string;
  factoryIndex: IndexedFactory[];
  select: (path: string) => void;
  onTopValue: OnTopValue;
}) {
  const results = useMemo(
    () => filterIndex(factoryIndex, query, CAP_SINGLE),
    [factoryIndex, query],
  );
  useReportTop(
    results[0] ? valueOfFactory(results[0].entry.item) : '',
    onTopValue,
  );
  if (results.length === 0) return null;
  return (
    <Command.Group heading="Factories">
      {results.map(r => (
        <FactoryRow key={r.entry.item.id} entry={r.entry} select={select} />
      ))}
    </Command.Group>
  );
}

function ItemsPage({
  query,
  select,
  onTopValue,
}: {
  query: string;
  select: (path: string) => void;
  onTopValue: OnTopValue;
}) {
  const results = useMemo(
    () => filterIndex(ITEM_INDEX, query, CAP_SINGLE),
    [query],
  );
  useReportTop(
    results[0] ? valueOfItem(results[0].entry.item) : '',
    onTopValue,
  );
  if (results.length === 0) return null;
  return (
    <Command.Group heading="Items">
      {results.map(r => (
        <ItemRow key={r.entry.item.id} item={r.entry.item} select={select} />
      ))}
    </Command.Group>
  );
}

function BuildingsPage({
  query,
  select,
  onTopValue,
}: {
  query: string;
  select: (path: string) => void;
  onTopValue: OnTopValue;
}) {
  const results = useMemo(
    () => filterIndex(BUILDING_INDEX, query, CAP_SINGLE),
    [query],
  );
  useReportTop(
    results[0] ? valueOfBuilding(results[0].entry.item) : '',
    onTopValue,
  );
  if (results.length === 0) return null;
  return (
    <Command.Group heading="Buildings">
      {results.map(r => (
        <BuildingRow
          key={r.entry.item.id}
          building={r.entry.item}
          category={r.entry.category}
          select={select}
        />
      ))}
    </Command.Group>
  );
}

function RecipesPage({
  query,
  select,
  onTopValue,
}: {
  query: string;
  select: (path: string) => void;
  onTopValue: OnTopValue;
}) {
  const results = useMemo(
    () => filterIndex(RECIPE_INDEX, query, CAP_SINGLE),
    [query],
  );
  useReportTop(
    results[0] ? valueOfRecipe(results[0].entry.item) : '',
    onTopValue,
  );
  if (results.length === 0) return null;
  return (
    <Command.Group heading="Recipes">
      {results.map(r => (
        <RecipeRow
          key={r.entry.item.id}
          recipe={r.entry.item}
          select={select}
        />
      ))}
    </Command.Group>
  );
}

function TiersPage({
  query,
  select,
  onTopValue,
}: {
  query: string;
  select: (path: string) => void;
  onTopValue: OnTopValue;
}) {
  const results = useMemo(
    () => filterIndex(TIER_INDEX, query, CAP_SINGLE),
    [query],
  );
  useReportTop(
    results[0]
      ? valueOfTier(results[0].entry.item, results[0].entry.milestoneNames)
      : '',
    onTopValue,
  );
  if (results.length === 0) return null;
  return (
    <Command.Group heading="Tiers">
      {results.map(r => (
        <TierRow
          key={r.entry.item.tier}
          group={r.entry.item}
          milestoneNames={r.entry.milestoneNames}
          select={select}
        />
      ))}
    </Command.Group>
  );
}

function UnifiedResultsPage({
  query,
  factoryIndex,
  select,
  onTopValue,
}: {
  query: string;
  factoryIndex: IndexedFactory[];
  select: (path: string) => void;
  onTopValue: OnTopValue;
}) {
  const factoryResults = useMemo(
    () => filterIndex(factoryIndex, query, CAP_FACTORIES),
    [factoryIndex, query],
  );
  const itemResults = useMemo(
    () => filterIndex(ITEM_INDEX, query, CAP_ITEMS),
    [query],
  );
  const buildingResults = useMemo(
    () => filterIndex(BUILDING_INDEX, query, CAP_BUILDINGS),
    [query],
  );
  const recipeResults = useMemo(
    () => filterIndex(RECIPE_INDEX, query, CAP_RECIPES),
    [query],
  );
  const tierResults = useMemo(
    () => filterIndex(TIER_INDEX, query, CAP_TIERS),
    [query],
  );

  // Tiers are noisy under fuzzy matching (most queries find some subsequence
  // hit in a milestone name). Only show the tier group when its top match is
  // a strong one, e.g., typing "tier 4" or a full milestone name.
  const showTiers =
    tierResults.length > 0 && tierResults[0].score >= TIER_MIN_SCORE;

  // The visual order of groups is fixed (factories → items → buildings →
  // recipes → tiers), but the cmdk highlight should land on the globally
  // highest-scoring row so Enter selects the actual best match. Compute the
  // top value across all visible groups and report it up.
  const topValue = useMemo(() => {
    let best: { value: string; score: number } = { value: '', score: 0 };
    const consider = (value: string, score: number) => {
      if (score > best.score) best = { value, score };
    };
    if (factoryResults[0]) {
      consider(
        valueOfFactory(factoryResults[0].entry.item),
        factoryResults[0].score,
      );
    }
    if (itemResults[0]) {
      consider(valueOfItem(itemResults[0].entry.item), itemResults[0].score);
    }
    if (buildingResults[0]) {
      consider(
        valueOfBuilding(buildingResults[0].entry.item),
        buildingResults[0].score,
      );
    }
    if (recipeResults[0]) {
      consider(
        valueOfRecipe(recipeResults[0].entry.item),
        recipeResults[0].score,
      );
    }
    if (showTiers && tierResults[0]) {
      consider(
        valueOfTier(
          tierResults[0].entry.item,
          tierResults[0].entry.milestoneNames,
        ),
        tierResults[0].score,
      );
    }
    return best.value;
  }, [
    factoryResults,
    itemResults,
    buildingResults,
    recipeResults,
    tierResults,
    showTiers,
  ]);
  useReportTop(topValue, onTopValue);

  // Fixed group order, matching the original spotlight:
  // factories → items → buildings → recipes → tiers.
  return (
    <>
      {factoryResults.length > 0 && (
        <Command.Group heading="Factories">
          {factoryResults.map(r => (
            <FactoryRow key={r.entry.item.id} entry={r.entry} select={select} />
          ))}
        </Command.Group>
      )}
      {itemResults.length > 0 && (
        <Command.Group heading="Items">
          {itemResults.map(r => (
            <ItemRow
              key={r.entry.item.id}
              item={r.entry.item}
              select={select}
            />
          ))}
        </Command.Group>
      )}
      {buildingResults.length > 0 && (
        <Command.Group heading="Buildings">
          {buildingResults.map(r => (
            <BuildingRow
              key={r.entry.item.id}
              building={r.entry.item}
              category={r.entry.category}
              select={select}
            />
          ))}
        </Command.Group>
      )}
      {recipeResults.length > 0 && (
        <Command.Group heading="Recipes">
          {recipeResults.map(r => (
            <RecipeRow
              key={r.entry.item.id}
              recipe={r.entry.item}
              select={select}
            />
          ))}
        </Command.Group>
      )}
      {showTiers && (
        <Command.Group heading="Tiers">
          {tierResults.map(r => (
            <TierRow
              key={r.entry.item.tier}
              group={r.entry.item}
              milestoneNames={r.entry.milestoneNames}
              select={select}
            />
          ))}
        </Command.Group>
      )}
    </>
  );
}

const FactoryRow = memo(function FactoryRow({
  entry,
  select,
}: {
  entry: IndexedFactory;
  select: (path: string) => void;
}) {
  const f = entry.item;
  const { outputs } = entry;
  return (
    <Command.Item
      value={valueOfFactory(f)}
      onSelect={() => select(`/factories/${f.id}/calculator`)}
    >
      <div className="cmdk-item-icon">
        <IconHomeCog size={22} />
      </div>
      <div className="cmdk-item-content">
        <span className="cmdk-item-label">{f.name || 'Unnamed Factory'}</span>
        {outputs.length > 0 && (
          <span className="cmdk-item-outputs">
            {outputs.map((o, i) => {
              const item = AllFactoryItemsMap[o.resource];
              return (
                <span key={o.resource} className="cmdk-item-output">
                  {i > 0 && <span className="cmdk-item-output-sep">·</span>}
                  <FactoryItemImage id={o.resource} size={16} />
                  <span>{item?.displayName ?? o.resource}</span>
                  {o.amount != null && (
                    <span className="cmdk-item-output-amount">
                      {o.amount}/min
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        )}
      </div>
    </Command.Item>
  );
});

const ItemRow = memo(function ItemRow({
  item,
  select,
}: {
  item: FactoryItem;
  select: (path: string) => void;
}) {
  return (
    <Command.Item
      value={valueOfItem(item)}
      onSelect={() => select(`/codex/items/${item.id}`)}
    >
      <div className="cmdk-item-icon">
        <FactoryItemImage id={item.id} size={24} />
      </div>
      <div className="cmdk-item-content">
        <span className="cmdk-item-label">{item.displayName}</span>
        <span className="cmdk-item-description">{item.form}</span>
      </div>
    </Command.Item>
  );
});

const BuildingRow = memo(function BuildingRow({
  building: b,
  category,
  select,
}: {
  building: FactoryBuilding;
  category: string;
  select: (path: string) => void;
}) {
  return (
    <Command.Item
      value={valueOfBuilding(b)}
      onSelect={() => select(`/codex/buildings/${b.id}`)}
    >
      <div className="cmdk-item-icon">
        <img
          width={24}
          height={24}
          loading="lazy"
          alt=""
          src={b.imagePath?.replace('_256', '_64')}
          style={{ objectFit: 'contain' }}
        />
      </div>
      <div className="cmdk-item-content">
        <span className="cmdk-item-label">{b.name}</span>
        <span className="cmdk-item-description">{category}</span>
      </div>
    </Command.Item>
  );
});

const RecipeRow = memo(function RecipeRow({
  recipe: r,
  select,
}: {
  recipe: FactoryRecipe;
  select: (path: string) => void;
}) {
  return (
    <Command.Item
      value={valueOfRecipe(r)}
      onSelect={() => select(`/codex/recipes/${r.id}`)}
    >
      <div className="cmdk-item-icon">
        <FactoryItemImage id={r.products[0]?.resource} size={24} />
      </div>
      <div className="cmdk-item-content">
        <span className="cmdk-item-label">{r.name}</span>
      </div>
    </Command.Item>
  );
});

const TierRow = memo(function TierRow({
  group,
  milestoneNames,
  select,
}: {
  group: TierGroup;
  milestoneNames: string;
  select: (path: string) => void;
}) {
  return (
    <Command.Item
      value={valueOfTier(group, milestoneNames)}
      onSelect={() => select(`/codex/tiers/${group.tier}`)}
    >
      <div className="cmdk-item-icon">
        <IconStairsUp size={22} />
      </div>
      <div className="cmdk-item-content">
        <span className="cmdk-item-label">Tier {group.tier}</span>
        <span className="cmdk-item-description">{milestoneNames}</span>
      </div>
    </Command.Item>
  );
});
