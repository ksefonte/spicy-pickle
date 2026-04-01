import { useEffect } from "react";
import { useNavigate } from "react-router";

export default function AppIndex() {
  const navigate = useNavigate();

  useEffect(() => {
    void navigate("/app/picklist", { replace: true });
  }, [navigate]);

  return null;
}
