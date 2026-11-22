import { configure } from "@testing-library/react";

// Testing Library wartet standardmaessig nur 1 s. Unter Serverlast (parallele
// Agenten-/Gradle-Laeufe) brauchen findBy*/waitFor auch bei gruenen Tests laenger.
configure({ asyncUtilTimeout: 5000 });
