import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenPoImportLookup } from "./OpenPoImportLookup";
const state = vi.hoisted(() => ({
  query: vi.fn(),
  selected: vi.fn(),
  refetch: vi.fn(),
  data: {
    items: [{ id: "product", name: "Stock product 000012" }],
    hasMore: true,
    page: 0,
  },
  isError: false,
}));
vi.mock("@/lib/operations", () => ({
  useOperation: (path: string, roles: string[]) => {
    state.query(path, roles);
    return { data: state.data, isError: state.isError, refetch: state.refetch };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.isError = false;
});
afterEach(cleanup);
const mount = () =>
  render(
    <OpenPoImportLookup
      kind="product"
      label="stock product"
      selected={undefined}
      describe={(item: { id: string; name: string }) => item.name}
      onSelect={state.selected}
    />,
  );
it("does not query or pick a default before the owner explicitly opens a selector", () => {
  mount();
  expect(state.query).toHaveBeenLastCalledWith(
    "/open-po-imports/options?kind=product&q=&page=0",
    [],
  );
  expect(
    screen.queryByRole("button", { name: "Stock product 000012" }),
  ).not.toBeInTheDocument();
  expect(state.selected).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Choose stock product" }));
  expect(state.query).toHaveBeenLastCalledWith(
    "/open-po-imports/options?kind=product&q=&page=0",
    ["owner"],
  );
  fireEvent.click(screen.getByRole("button", { name: "Stock product 000012" }));
  expect(state.selected).toHaveBeenCalledExactlyOnceWith(state.data.items[0]);
  expect(
    screen.queryByLabelText("Search stock product"),
  ).not.toBeInTheDocument();
});
it("preserves leading-zero search text and uses bounded pagination rather than a whole catalog", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Choose stock product" }));
  fireEvent.change(screen.getByLabelText("Search stock product"), {
    target: { value: "000012" },
  });
  fireEvent.click(screen.getByRole("button", { name: "More choices" }));
  expect(state.query).toHaveBeenLastCalledWith(
    "/open-po-imports/options?kind=product&q=000012&page=1",
    ["owner"],
  );
  expect(state.selected).not.toHaveBeenCalled();
});
it("does not offer stale cached selections after a failed lookup", () => {
  state.isError = true;
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Choose stock product" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choices could not be loaded",
  );
  expect(
    screen.queryByRole("button", { name: "Stock product 000012" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry choices" }));
  expect(state.refetch).toHaveBeenCalledOnce();
  expect(state.selected).not.toHaveBeenCalled();
});
