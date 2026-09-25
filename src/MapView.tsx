import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Results } from './physics';

export default function MapView({
  lat,
  lng,
  onPick,
  results,
  shockKm,
}: {
  lat: number;
  lng: number;
  onPick: (a: number, b: number) => void;
  results: Results | null;
  shockKm: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const shock = useRef<L.Circle | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, preferCanvas: true }).setView([lat, lng], 9);

    // Standard OpenStreetMap layer (universally supported, reliable)
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
      crossOrigin: true,
    });

    // High-visibility Carto Voyager fallback layer
    const cartoLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© CARTO © OSM',
      maxZoom: 19,
      crossOrigin: true,
    });

    osmLayer.addTo(m);

    // Layer control so user can switch between styles if desired
    L.control.layers({
      'OpenStreetMap Standard': osmLayer,
      'Carto Voyager': cartoLayer,
    }, undefined, { position: 'topright' }).addTo(m);

    m.on('click', (e: L.LeafletMouseEvent) => pick.current(e.latlng.lat, e.latlng.lng));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;

    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);

    setTimeout(() => m.invalidateSize(), 150);
    setTimeout(() => m.invalidateSize(), 500);

    return () => {
      ro.disconnect();
      m.remove();
    };
  }, []);

  useEffect(() => {
    if (!layer.current || !map.current) return;
    const g = layer.current;
    g.clearLayers();
    shock.current = null;

    const icon = L.divIcon({
      className: '',
      html: '<div class="epi"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    L.marker([lat, lng], { icon })
      .addTo(g)
      .bindTooltip(`Ground Zero<br>${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    if (results) {
      const zones: [number, string, string][] = [
        [results.lightDamage, '#eab308', '1 psi – window breakage'],
        [results.thermal, '#f97316', '3rd-degree burns'],
        [results.overpressure, '#ef4444', '5 psi – structural collapse'],
        [results.fireball, '#fde047', 'Thermal fireball'],
        [results.craterD / 2, '#a855f7', 'Crater rim'],
      ];
      const sorted = zones.filter(z => z[0] > 0).sort((a, b) => b[0] - a[0]);
      sorted.forEach(([r, c, n]) =>
        L.circle([lat, lng], {
          radius: r * 1000,
          color: c,
          weight: 2,
          fillColor: c,
          fillOpacity: 0.18,
        })
          .addTo(g)
          .bindTooltip(`${n}: ${r.toFixed(2)} km`)
      );

      shock.current = L.circle([lat, lng], {
        radius: 1,
        color: '#38bdf8',
        weight: 2.5,
        fill: false,
        dashArray: '5 6',
      }).addTo(g);

      if (sorted[0]) {
        map.current.fitBounds(L.latLng(lat, lng).toBounds(sorted[0][0] * 2300), { animate: true });
      }
    } else {
      map.current.setView([lat, lng], map.current.getZoom());
    }
  }, [lat, lng, results]);

  useEffect(() => {
    shock.current?.setRadius(Math.max(1, shockKm * 1000));
  }, [shockKm]);

  return <div ref={el} className="h-full w-full min-h-[140px]" />;
}
