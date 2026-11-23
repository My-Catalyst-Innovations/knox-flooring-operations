import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PasswordInput } from "./password-input";

afterEach(cleanup);

it("lets a user inspect and hide the typed password without submitting or changing it", () => {
  const submit = vi.fn();
  function SignInForm() {
    const [password, setPassword] = useState("");
    return <form onSubmit={(event) => { event.preventDefault(); submit(password); }}>
      <label htmlFor="test-password">Password</label>
      <PasswordInput id="test-password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
      <button type="submit">Sign in</button>
    </form>;
  }
  render(<SignInForm />);
  const password = screen.getByLabelText("Password", { exact: true });
  fireEvent.change(password, { target: { value: "Fictional password for UI test" } });
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(submit).not.toHaveBeenCalled();
  expect(password).toHaveAttribute("type", "text");
  expect(password).toHaveAttribute("autocomplete", "current-password");
  expect(screen.getByRole("button", { name: "Hide password", pressed: true })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(password).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(submit).toHaveBeenCalledExactlyOnceWith("Fictional password for UI test");
});
