import * as React from "react";
import { Input } from "@/components/ui/input";

type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, "type"> & {
  passwordLabel?: string;
};

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, id, disabled, passwordLabel = "password", ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input
          {...props}
          id={inputId}
          ref={ref}
          type={visible ? "text" : "password"}
          disabled={disabled}
          className={["pr-16", className].filter(Boolean).join(" ")}
        />
        <button
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${passwordLabel}`}
          aria-controls={inputId}
          aria-pressed={visible}
          disabled={disabled}
          className="absolute inset-y-0 right-0 min-w-16 rounded-r-md px-3 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
