import React, { useState } from "react";
import { X, Loader2 } from "lucide-react";

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (amount: number) => void;
  isLoading?: boolean;
}

const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  isLoading = false,
}) => {
  const [amount, setAmount] = useState(5);
  const [customAmount, setCustomAmount] = useState("");

  const presetAmounts = [5, 20, 100, 500];
  const MIN_AMOUNT = 5;

  const handlePresetClick = (value: number) => {
    setAmount(value);
    setCustomAmount("");
  };

  const handleCustomAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9]/g, "");
    setCustomAmount(value);

    if (value === "") {
      setAmount(5);
      return;
    }

    const numValue = parseInt(value, 10);
    if (numValue >= MIN_AMOUNT) {
      setAmount(numValue);
    }
  };

  const handleSubmit = () => {
    if (amount >= MIN_AMOUNT) {
      onSubmit(amount);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="relative w-[420px] transform overflow-hidden rounded-xl border border-border bg-background duration-200 animate-in fade-in zoom-in-95"
        style={{
          boxShadow: "0 20px 40px rgba(0,0,0,0.3)",
        }}
      >
        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm font-medium text-muted-foreground">
                Redirecting to checkout...
              </p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-muted/30 p-5">
          <h2
            className="text-lg font-bold tracking-wider text-foreground"
            style={{ fontFamily: "monospace" }}
          >
            ADD CREDITS
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg bg-muted p-2 transition-all hover:bg-muted/80 active:scale-95"
            disabled={isLoading}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Main Content */}
        <div className="p-6">
          {/* Amount Display */}
          <div className="mb-6 rounded-lg border border-border bg-muted/20 p-6 text-center">
            <div className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Amount
            </div>
            <div
              className="text-5xl font-bold text-foreground"
              style={{ fontFamily: "monospace" }}
            >
              ${amount}
            </div>
          </div>

          {/* Preset Buttons */}
          <div className="mb-6 grid grid-cols-4 gap-2">
            {presetAmounts.map((preset) => (
              <button
                key={preset}
                onClick={() => handlePresetClick(preset)}
                className={`rounded-lg px-3 py-3 text-sm font-bold transition-all active:scale-95 ${
                  amount === preset && !customAmount
                    ? "bg-primary text-primary-foreground shadow-lg"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
                style={{
                  fontFamily: "monospace",
                }}
              >
                ${preset}
              </button>
            ))}
          </div>

          {/* Custom Amount Input */}
          <div className="mb-6">
            <label className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Or enter custom amount
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                $
              </span>
              <input
                type="text"
                value={customAmount}
                onChange={handleCustomAmountChange}
                placeholder="Enter amount"
                className="w-full rounded-lg border border-border bg-muted/20 py-3 pl-8 pr-3 text-sm font-medium outline-none transition-all placeholder:text-muted-foreground/50 focus:border-primary focus:bg-muted/30"
                style={{
                  fontFamily: "monospace",
                }}
              />
              {customAmount && parseInt(customAmount, 10) < MIN_AMOUNT && (
                <div className="mt-1 text-xs text-destructive">
                  Minimum amount is ${MIN_AMOUNT}
                </div>
              )}
            </div>
          </div>

          {/* Total Display */}
          <div className="mb-6 rounded-lg border border-primary/20 bg-primary/5 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                Total (USD)
              </span>
              <span
                className="text-2xl font-bold text-foreground"
                style={{ fontFamily: "monospace" }}
              >
                ${amount.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isLoading}
              className="flex-1 rounded-lg border border-border bg-background px-4 py-3 text-sm font-bold text-foreground transition-all hover:bg-muted active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                fontFamily: "monospace",
              }}
            >
              CANCEL
            </button>
            <button
              onClick={handleSubmit}
              disabled={amount < MIN_AMOUNT || isLoading}
              className={`flex-1 rounded-lg px-4 py-3 text-sm font-bold transition-all active:scale-95 ${
                amount >= MIN_AMOUNT && !isLoading
                  ? "bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted/30 text-muted-foreground"
              }`}
              style={{
                fontFamily: "monospace",
              }}
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  PROCESSING...
                </span>
              ) : (
                "ADD CREDITS"
              )}
            </button>
          </div>

          {/* Min/Max Info */}
          <div className="mt-4 text-center text-xs text-muted-foreground">
            Min: ${MIN_AMOUNT}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PaymentModal;
