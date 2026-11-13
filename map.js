import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

mapboxgl.accessToken = 'pk.eyJ1Ijoic250aXdhcmkiLCJhIjoiY213ZmtqbnU5MDg1bzJ6cTI5cmI2cDN4NCJ9.FPCQ0zDQRYJkYO7dwCDgSA';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027], // [lon, lat]
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// same look for boston and cambridge lanes
const bikeLaneStyle = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.4,
};

// one list per minute of the day, so filtering is just grabbing a few lists instead of scanning all 260k trips
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// turns map lon/lat into pixel spots on the screen
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// minutes like 485 become "8:05 AM"
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// grabs every trip within an hour of the picked minute
// the % wraps around midnight so 11:30pm still sees 12:15am trips
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }

  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// counts arrivals and departures for each station, only for trips in the time window
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// 1 = mostly leaving, 0.5 = even, 0 = mostly arriving
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// stations with no trips would be 0/0 = NaN and lose their color, so call them balanced
function departureRatio(d) {
  return d.totalTraffic === 0 ? 0.5 : stationFlow(d.departures / d.totalTraffic);
}

map.on('load', async () => {
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: bikeLaneStyle,
  });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLaneStyle,
  });

  let jsonData;
  try {
    jsonData = await d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json');
    console.log('Loaded JSON Data:', jsonData);
  } catch (error) {
    console.error('Error loading JSON:', error);
    return;
  }

  // parse the dates as each row comes in, and drop it into its minute bucket while were at it
  await d3.csv('https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv', (trip) => {
    trip.started_at = new Date(trip.started_at);
    trip.ended_at = new Date(trip.ended_at);
    departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
    arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);
    return trip;
  });

  let stations = computeStationTraffic(jsonData.data.stations);
  console.log('Stations Array:', stations);

  // sqrt so the circle area matches traffic, not the radius
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  const svg = d3.select('#map').select('svg');

  // short_name as the key so d3 keeps each circle stuck to the same station when the data changes
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', departureRatio)
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
    });

  // moves the circles to match the map whenever it pans or zooms
  function updatePositions() {
    circles.attr('cx', (d) => getCoords(d).cx).attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  // redoes the counts for the picked time and resizes and recolors the circles
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // bigger range when filtering because way fewer trips means tiny circles otherwise
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', departureRatio)
      .select('title')
      .text((d) => `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
  }

  function updateTimeDisplay() {
    let timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
