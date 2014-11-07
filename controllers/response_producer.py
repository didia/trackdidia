'''
Created on 2014-11-06

@author: didia
'''
import webapp2
from collections import OrderedDict

def produce_slot_response(request, slot, schedule_id, day_id):
    response = OrderedDict()
    slot_id = slot.key.integer_id()
    executed = '0' if slot.executed else '1'
    response['slot_id'] = slot.key.integer_id()
    response['offset'] = slot.offset
    response['duration'] = slot.duration
    response['executed'] = slot.executed
    response['task_id'] = slot.task.integer_id()
    links = {}
    links['get'] = webapp2.uri_for('get_slot', _request = request, schedule_id = schedule_id, day_id = day_id, slot_id = slot_id)
    links['update'] = webapp2.uri_for('update_slot', _request = request,  schedule_id = schedule_id, day_id = day_id, slot_id = slot_id)
    links['delete'] = webapp2.uri_for('delete_slot', _request = request,  schedule_id = schedule_id, day_id = day_id, slot_id = slot_id)
    links['set_executed'] = webapp2.uri_for('set_executed_slot', _request = request, schedule_id = schedule_id, day_id = day_id, slot_id = slot_id, executed=executed)
    
    response['links'] = links
    
    return response

def produce_day_response(request, day, schedule_id):
    response = OrderedDict()
    day_id = day.key.integer_id()
    response['day_id'] = day.key.integer_id()
    response['interval_usage'] = day.interval_usage
    slots = [produce_slot_response(request, slot, schedule_id, day_id) for slot in day.get_slots()]
    response['slots'] = slots
    links = {}
    links['get_day'] = webapp2.uri_for('get_day', _request = request, schedule_id = schedule_id, day_id = day_id)
    response['links'] = links
        
    return response

def produce_schedule_response(request, schedule):
    response = OrderedDict()
    schedule_id = schedule.key.id()
    response['schedule_id'] = schedule_id
    response['interval'] = schedule.interval
    response['starting_date'] = schedule.starting_date.strftime("%d/%m/%Y")
    response['ending_date'] = schedule.ending_date.strftime("%d/%m/%Y")
    days = [produce_day_response(request, day, schedule_id) for day in schedule.get_all_days()]
    response['days'] = days
    links = {}
    links['get_schedule'] = webapp2.uri_for('get_schedule', _request = request, schedule_id = schedule_id)
    links['restart_schedule'] = webapp2.uri_for('restart_schedule', _request = request, schedule_id = schedule_id)
    response['links'] = links
        
    return response

def produce_task_response(request, task):
    response = OrderedDict()
    task_id = task.key.integer_id()
    response["id"] = task.key.integer_id()
    response["name"] = task.name
    response["description"] = task.description
    response["location"] = task.location
    response["category"] = task.category
    response["priority"] = task.priority
    
    links = {}
    
    links['get_task'] = webapp2.uri_for('get_task', _request=request, task_id = task_id)
    links['update_task'] = webapp2.uri_for('update_task', _request=request, task_id = task_id)
    
    response['links'] = links
    
    return response