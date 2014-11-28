'''
Created on 2014-11-06

@author: didia
'''
import webapp2
from collections import OrderedDict

def produce_scheduled_task_response(request, scheduled_task, day_id, week_id):
    response = OrderedDict()
    scheduled_task_id = scheduled_task.key.integer_id()
    executed = '0' if scheduled_task.executed else '1'
    response['id'] = scheduled_task_id
    response['offset'] = scheduled_task.offset
    response['duration'] = scheduled_task.duration
    response['executed'] = scheduled_task.executed
    response['task_id'] = scheduled_task.task.integer_id()
    links = {}
    links['get'] = webapp2.uri_for('get_scheduled_task', _request = request, week_id = week_id, day_id = day_id, scheduled_task_id = scheduled_task_id)
    links['update'] = webapp2.uri_for('update_scheduled_task', _request = request,  week_id = week_id, day_id = day_id, scheduled_task_id = scheduled_task_id)
    links['delete'] = webapp2.uri_for('delete_scheduled_task', _request = request,  week_id = week_id, day_id = day_id, scheduled_task_id = scheduled_task_id)
    links['set_executed'] = webapp2.uri_for('set_executed_scheduled_task', _request = request, week_id = week_id, day_id = day_id, scheduled_task_id = scheduled_task_id, executed=executed)
    
    response['links'] = links
    
    return response

def produce_day_response(request, day, week_id):
    response = OrderedDict()
    day_id = day.key.integer_id()
    response['id'] = day.key.integer_id()
    response['interval_usage'] = day.interval_usage
    scheduled_tasks = [produce_scheduled_task_response(request, slot, day_id, week_id) for slot in day.get_scheduled_tasks()]
    response['scheduled_tasks'] = scheduled_tasks
    links = {}
    links['get'] = webapp2.uri_for('get_day', _request = request, week_id = week_id, day_id = day_id)
    links['all_scheduled_tasks'] = webapp2.uri_for('all_scheduled_tasks', _request = request, week_id = week_id, day_id = day_id)
    links['create_scheduled_task'] = webapp2.uri_for('create_scheduled_task', _request = request, week_id = week_id, day_id = day_id)
    response['links'] = links
        
    return response

def produce_week_response(request, week):
    response = OrderedDict()
    week_id = week.key.id()
    response['id'] = week_id
    response['interval'] = week.interval
    response['starting_date'] = week.starting_date.strftime("%d/%m/%Y")
    response['ending_date'] = week.ending_date.strftime("%d/%m/%Y")
    days = [produce_day_response(request, day, week_id) for day in week.get_all_days()]
    response['days'] = days
    links = {}
    links['get_week'] = webapp2.uri_for('get_week', _request = request, week_id = week_id)
    links['stat'] = webapp2.uri_for('get_week_stat', _request = request, week_id = week_id)
    links['restart'] = webapp2.uri_for('restart_week', _request = request, week_id = week_id)
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